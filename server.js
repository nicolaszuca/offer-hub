const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── MEDIA DIRS ───────────────────────────────────────────────────────────────
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, 'public', 'videos');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, 'public', 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.HUB_PASSWORD || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || 'hub.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS queue (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE TABLE IF NOT EXISTS saved (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    analysis TEXT,
    saved_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
`);

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const AUTH_ENABLED = PASSWORD.length > 0;
const getToken = () =>
  AUTH_ENABLED
    ? crypto.createHash('sha256').update(PASSWORD + 'offer-hub-salt').digest('hex')
    : 'no-auth';

function auth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '').trim();
  if (token !== getToken()) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve vídeos do VIDEOS_DIR (pode ser volume externo)
app.use('/videos', express.static(VIDEOS_DIR));
app.use('/images', express.static(IMAGES_DIR));

// ─── AUTH ROUTE ───────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ token: 'no-auth' });
  const { password } = req.body || {};
  if (!password || password !== PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  res.json({ token: getToken() });
});

// ─── QUEUE ────────────────────────────────────────────────────────────────────
app.get('/api/queue', auth, (req, res) => {
  const rows = db.prepare('SELECT id, data FROM queue ORDER BY rowid DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});

// ─── IMAGE DOWNLOAD ───────────────────────────────────────────────────────────
async function downloadImage(url, id) {
  try {
    const filePath = path.join(IMAGES_DIR, `${id}.jpg`);
    if (fs.existsSync(filePath)) return `/images/${id}.jpg`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buf));
    console.log(`[image] Salvo: ${id}.jpg (${Math.round(buf.byteLength/1024)}KB)`);
    return `/images/${id}.jpg`;
  } catch (e) {
    console.warn(`[image] Erro ao baixar ${id}:`, e.message);
    return null;
  }
}

// ─── VIDEO DOWNLOAD ───────────────────────────────────────────────────────────
async function downloadVideo(url, id) {
  try {
    const filePath = path.join(VIDEOS_DIR, `${id}.mp4`);
    if (fs.existsSync(filePath)) return `/videos/${id}.mp4`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buf));
    console.log(`[video] Salvo: ${id}.mp4 (${Math.round(buf.byteLength/1024)}KB)`);
    return `/videos/${id}.mp4`;
  } catch (e) {
    console.warn(`[video] Erro ao baixar ${id}:`, e.message);
    return null;
  }
}

app.post('/api/queue', auth, async (req, res) => {
  const ads = Array.isArray(req.body) ? req.body : [req.body];
  const insert = db.prepare('INSERT OR IGNORE INTO queue (id, data) VALUES (?, ?)');

  // Responde imediatamente, baixa vídeos em background
  const prepared = ads.map(ad => {
    if (!ad.id) ad.id = crypto.randomUUID();
    return ad;
  });

  const insertMany = db.transaction((items) => {
    for (const ad of items) insert.run(ad.id, JSON.stringify(ad));
  });
  insertMany(prepared);
  res.json({ ok: true, count: prepared.length });

  // Download de mídia em background (não bloqueia resposta)
  for (const ad of prepared) {
    if (ad.videoUrl && !ad.videoUrl.startsWith('/videos/')) {
      downloadVideo(ad.videoUrl, ad.id).then(localPath => {
        if (localPath) {
          ad.videoUrl = localPath;
          db.prepare('UPDATE queue SET data = ? WHERE id = ?').run(JSON.stringify(ad), ad.id);
        }
      });
    }
    if (ad.imageUrl && !ad.imageUrl.startsWith('/images/')) {
      downloadImage(ad.imageUrl, ad.id).then(localPath => {
        if (localPath) {
          ad.imageUrl = localPath;
          db.prepare('UPDATE queue SET data = ? WHERE id = ?').run(JSON.stringify(ad), ad.id);
        }
      });
    }
  }
});

app.delete('/api/queue/:id', auth, (req, res) => {
  db.prepare('DELETE FROM queue WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/queue', auth, (req, res) => {
  db.prepare('DELETE FROM queue').run();
  res.json({ ok: true });
});

// ─── SAVED ────────────────────────────────────────────────────────────────────
app.get('/api/saved', auth, (req, res) => {
  const rows = db.prepare('SELECT id, data, analysis FROM saved ORDER BY saved_at DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, analysis: r.analysis })));
});

app.post('/api/saved', auth, async (req, res) => {
  const ad = req.body;
  if (!ad.id) ad.id = crypto.randomUUID();
  db.prepare('INSERT OR REPLACE INTO saved (id, data) VALUES (?, ?)').run(ad.id, JSON.s
