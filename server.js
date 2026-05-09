const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);

const ERLAUBTE_ORIGINS = [
  'https://weberding.de',
  'https://www.weberding.de',
  'http://localhost:4174',
  'http://localhost:3000',
  'http://127.0.0.1:4174',
  'http://127.0.0.1:3000',
];

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || ERLAUBTE_ORIGINS.includes(origin)) cb(null, true);
      else cb(new Error('CORS blockiert'));
    },
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3010;
const FRAGE_DAUER_MS = 15_000;
const AUFLOESUNGS_PAUSE_MS = 3_500;
const MAX_SPIELER = 8;
const INAKTIVITAET_MS = 30 * 60 * 1_000;
const MAX_FRAGEN = 50;

const raeume = new Map();
const rate_map = new Map();

function pruefe_rate_limit(ip) {
  const jetzt = Date.now();
  const e = rate_map.get(ip);
  if (!e || jetzt > e.reset) { rate_map.set(ip, { count: 1, reset: jetzt + 60_000 }); return true; }
  if (e.count >= 5) return false;
  e.count++;
  return true;
}

function erzeuge_code() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); }
  while (raeume.has(code));
  return code;
}

function loesche_raum(code) {
  const r = raeume.get(code);
  if (!r) return;
  clearInterval(r.frage_timer);
  clearTimeout(r.aufloesungs_timer);
  clearTimeout(r.inaktiv_timer);
  raeume.delete(code);
}

function reset_inaktiv(r) {
  clearTimeout(r.inaktiv_timer);
  r.inaktiv_timer = setTimeout(() => loesche_raum(r.code), INAKTIVITAET_MS);
}

function broadcast_spieler_liste(r) {
  const liste = r.spieler.map(s => ({ id: s.id, name: s.name, score: s.score, host: s.id === r.host_id }));
  io.to(r.code).emit('spieler_liste', liste);
}

function naechste_frage(code) {
  const r = raeume.get(code);
  if (!r) return;
  r.frage_index++;
  if (r.frage_index >= r.fragen.length) {
    r.zustand = 'ende';
    const rangliste = [...r.spieler].sort((a, b) => b.score - a.score)
      .map((s, i) => ({ rang: i + 1, name: s.name, score: s.score }));
    io.to(code).emit('spiel_ende', { rangliste });
    loesche_raum(code);
    return;
  }
  r.antworten_aktuell = {};
  r.zustand = 'frage';
  r.frage_start = Date.now();
  const frage = r.fragen[r.frage_index];
  io.to(code).emit('frage', {
    index: r.frage_index,
    total: r.fragen.length,
    text: frage.text,
    antworten: frage.antworten,
    modus: r.modus,
  });
  let verbleibend = Math.round(FRAGE_DAUER_MS / 1000);
  clearInterval(r.frage_timer);
  r.frage_timer = setInterval(() => {
    verbleibend--;
    io.to(code).emit('countdown', { sekunden: verbleibend });
    if (verbleibend <= 0) { clearInterval(r.frage_timer); r.frage_timer = null; zeige_aufloesung(code); }
  }, 1000);
}

function zeige_aufloesung(code) {
  const r = raeume.get(code);
  if (!r || r.zustand !== 'frage') return;
  r.zustand = 'aufloesung';
  clearInterval(r.frage_timer); r.frage_timer = null;
  const frage = r.fragen[r.frage_index];
  io.to(code).emit('aufloesung', {
    richtig_index: frage.richtig,
    scores: r.spieler.map(s => ({ name: s.name, score: s.score })),
  });
  clearTimeout(r.aufloesungs_timer);
  r.aufloesungs_timer = setTimeout(() => naechste_frage(code), AUFLOESUNGS_PAUSE_MS);
}

app.get('/', (_req, res) => res.send('Quiz-Server läuft ✓'));
app.get('/health', (_req, res) => res.json({ status: 'ok', raeume: raeume.size }));

io.on('connection', (socket) => {
  const ip = (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || socket.handshake.address;

  socket.on('raum_erstellen', ({ modus, name }) => {
    if (!pruefe_rate_limit(ip)) {
      socket.emit('fehler', { meldung: 'Zu viele Räume erstellt – bitte kurz warten.' });
      return;
    }
    const code = erzeuge_code();
    const spieler_name = String(name || 'Host').trim().slice(0, 24) || 'Host';
    const r = {
      code, host_id: socket.id,
      modus: modus === 'quattro' ? 'quattro' : 'duo',
      spieler: [{ id: socket.id, name: spieler_name, score: 0 }],
      fragen: [], frage_index: -1, antworten_aktuell: {},
      zustand: 'warten', frage_start: 0,
      frage_timer: null, aufloesungs_timer: null, inaktiv_timer: null,
    };
    raeume.set(code, r);
    reset_inaktiv(r);
    socket.join(code);
    socket.data.code = code;
    socket.emit('raum_erstellt', { code });
    broadcast_spieler_liste(r);
  });

  socket.on('raum_beitreten', ({ code, name }) => {
    const key = String(code || '').toUpperCase().trim();
    const r = raeume.get(key);
    if (!r) { socket.emit('fehler', { meldung: 'Raum nicht gefunden.' }); return; }
    if (r.zustand !== 'warten') { socket.emit('fehler', { meldung: 'Spiel läuft bereits.' }); return; }
    if (r.spieler.length >= MAX_SPIELER) { socket.emit('fehler', { meldung: `Raum voll (max. ${MAX_SPIELER}).` }); return; }
    const spieler_name = String(name || 'Gast').trim().slice(0, 24) || 'Gast';
    r.spieler.push({ id: socket.id, name: spieler_name, score: 0 });
    reset_inaktiv(r);
    socket.join(key);
    socket.data.code = key;
    socket.emit('raum_beigetreten', { code: key, modus: r.modus });
    broadcast_spieler_liste(r);
  });

  socket.on('spiel_starten', ({ fragen }) => {
    const r = raeume.get(socket.data.code);
    if (!r || r.host_id !== socket.id) return;
    if (!Array.isArray(fragen) || fragen.length === 0) {
      socket.emit('fehler', { meldung: 'Keine Fragen übermittelt.' }); return;
    }
    r.fragen = fragen.slice(0, MAX_FRAGEN).map(f => ({
      text: String(f.text || '').slice(0, 500),
      antworten: Array.isArray(f.antworten) ? f.antworten.slice(0, 4).map(a => String(a).slice(0, 200)) : [],
      richtig: Number.isInteger(f.richtig) ? f.richtig : 0,
    }));
    r.spieler.forEach(s => { s.score = 0; });
    r.frage_index = -1;
    naechste_frage(r.code);
  });

  socket.on('antwort_senden', ({ antwort_index }) => {
    const r = raeume.get(socket.data.code);
    if (!r || r.zustand !== 'frage') return;
    if (r.antworten_aktuell[socket.id] !== undefined) return;
    const idx = Number(antwort_index);
    const frage = r.fragen[r.frage_index];
    const korrekt = idx === frage.richtig;
    r.antworten_aktuell[socket.id] = idx;
    let punkte = 0;
    if (korrekt) {
      const bonus = Math.max(0, Math.round(((FRAGE_DAUER_MS - (Date.now() - r.frage_start)) / FRAGE_DAUER_MS) * 500));
      punkte = 1000 + bonus;
      const sp = r.spieler.find(s => s.id === socket.id);
      if (sp) sp.score += punkte;
    }
    socket.emit('antwort_bestaetigt', { korrekt, antwort_index: idx, punkte });
    if (r.spieler.every(s => r.antworten_aktuell[s.id] !== undefined)) zeige_aufloesung(r.code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    const r = raeume.get(code);
    if (!r) return;
    r.spieler = r.spieler.filter(s => s.id !== socket.id);
    if (r.spieler.length === 0) {
      loesche_raum(code);
    } else if (r.host_id === socket.id) {
      io.to(code).emit('raum_geschlossen', { meldung: 'Host hat den Raum verlassen.' });
      loesche_raum(code);
    } else {
      broadcast_spieler_liste(r);
    }
  });
});

httpServer.listen(PORT, () => console.log(`Quiz-Server auf Port ${PORT}`));
