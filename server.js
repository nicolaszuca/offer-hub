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

// Migração: ads que têm /images/... em imageUrl → move para localImageUrl e limpa imageUrl
function migrateImageUrls() {
  const tables = ['queue', 'saved'];
  for (const table of tables) {
    const rows = db.prepare(`SELECT id, data FROM ${table}`).all();
    const upd = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        const ad = JSON.parse(row.data);
        let changed = false;
        if (ad.imageUrl?.startsWith('/images/')) {
          ad.localImageUrl = ad.imageUrl;
          ad.imageUrl = '';
          changed = true;
        }
        if (changed) upd.run(JSON.stringify(ad), row.id);
      } catch (_) {}
    }
  }
}
migrateImageUrls();

// Migração assíncrona: baixa pageLogo para ads existentes sem localPageLogo
async function migratePageLogos() {
  const tables = ['queue', 'saved'];
  for (const table of tables) {
    const rows = db.prepare(`SELECT id, data FROM ${table}`).all();
    for (const row of rows) {
      try {
        const ad = JSON.parse(row.data);
        const logoFile = path.join(IMAGES_DIR, `${ad.id}-logo.jpg`);
        if (ad.pageLogo && ad.pageLogo.startsWith('http') && !fs.existsSync(logoFile)) {
          const localPath = await downloadImage(ad.pageLogo, ad.id, '-logo');
          if (localPath) {
            ad.localPageLogo = localPath;
            db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(ad), ad.id);
          }
        }
      } catch (_) {}
    }
  }
  console.log('[migrate] migratePageLogos concluído');
}

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
  if (token !== getToken()) return res.status(401).json({ error: 'Nao autorizado' });
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
app.use('/videos', express.static(VIDEOS_DIR));

// Serve imagens — se arquivo local sumir (redeploy), tenta re-baixar da URL original
app.use('/images', async (req, res, next) => {
  const filePath = path.join(IMAGES_DIR, req.path);
  if (fs.existsSync(filePath)) return next(); // arquivo existe, serve normalmente
  // Detecta se é logo (-logo) ou imagem principal
  const baseName = path.basename(req.path, path.extname(req.path));
  const isLogo = baseName.endsWith('-logo');
  const id = isLogo ? baseName.slice(0, -5) : baseName;
  const row = db.prepare(
    'SELECT data FROM queue WHERE id = ? UNION ALL SELECT data FROM saved WHERE id = ? LIMIT 1'
  ).get(id, id);
  if (row) {
    try {
      const ad = JSON.parse(row.data);
      let origUrl, suffix;
      if (isLogo) {
        origUrl = ad.pageLogo?.startsWith('http') ? ad.pageLogo : null;
        suffix = '-logo';
      } else {
        origUrl = ad.imageUrl?.startsWith('http') ? ad.imageUrl : null;
        suffix = '';
      }
      if (origUrl) {
        const localPath = await downloadImage(origUrl, id, suffix);
        if (localPath) {
          const upQ = db.prepare('UPDATE queue SET data = ? WHERE id = ?');
          const upS = db.prepare('UPDATE saved SET data = ? WHERE id = ?');
          if (isLogo) ad.localPageLogo = localPath;
          else ad.localImageUrl = localPath;
          upQ.run(JSON.stringify(ad), id);
          upS.run(JSON.stringify(ad), id);
          return res.sendFile(filePath);
        }
      }
    } catch (_) {}
  }
  next(); // 404
});
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
async function downloadImage(url, id, suffix = '') {
  try {
    const fname = suffix ? `${id}${suffix}.jpg` : `${id}.jpg`;
    const filePath = path.join(IMAGES_DIR, fname);
    if (fs.existsSync(filePath)) return `/images/${fname}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buf));
    console.log(`[image] Salvo: ${fname} (${Math.round(buf.byteLength/1024)}KB)`);
    return `/images/${fname}`;
  } catch (e) {
    console.warn(`[image] Erro ao baixar ${id}${suffix}:`, e.message);
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

// Retorna true se o anúncio tem CTA levando para página externa (VSL/landing page)
function hasExternalCta(ad) {
  if (ad.snapshotUrl && !ad.snapshotUrl.includes('facebook.com')) return true;
  if (ad.linkDesc || ad.linkTitle) return true;
  if (ad.ctaText && ad.ctaText.trim().length > 0) return true;
  return false;
}

app.post('/api/queue', auth, async (req, res) => {
  const ads = Array.isArray(req.body) ? req.body : [req.body];
  const insert = db.prepare('INSERT OR IGNORE INTO queue (id, data) VALUES (?, ?)');

  // Filtra apenas anúncios com CTA externo (landing page / VSL)
  const filtered = ads.filter(ad => hasExternalCta(ad));
  const skipped = ads.length - filtered.length;
  if (skipped > 0) console.log(`[queue] ${skipped} anúncio(s) ignorado(s) (sem link externo)`);

  const prepared = filtered.map(ad => {
    if (!ad.id) ad.id = crypto.randomUUID();
    return ad;
  });

  const insertMany = db.transaction((items) => {
    for (const ad of items) insert.run(ad.id, JSON.stringify(ad));
  });
  insertMany(prepared);
  res.json({ ok: true, count: prepared.length });

  for (const ad of prepared) {
    if (ad.videoUrl && !ad.videoUrl.startsWith('/videos/')) {
      downloadVideo(ad.videoUrl, ad.id).then(localPath => {
        if (localPath) {
          ad.videoUrl = localPath;
          db.prepare('UPDATE queue SET data = ? WHERE id = ?').run(JSON.stringify(ad), ad.id);
        }
      });
    }
    if (ad.imageUrl && !ad.imageUrl.startsWith('/images/') && !ad.localImageUrl) {
      downloadImage(ad.imageUrl, ad.id).then(localPath => {
        if (localPath) {
          ad.localImageUrl = localPath;
          db.prepare('UPDATE queue SET data = ? WHERE id = ?').run(JSON.stringify(ad), ad.id);
        }
      });
    }
    if (ad.pageLogo && ad.pageLogo.startsWith('http') && !ad.localPageLogo) {
      downloadImage(ad.pageLogo, ad.id, '-logo').then(localPath => {
        if (localPath) {
          ad.localPageLogo = localPath;
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
  db.prepare('INSERT OR REPLACE INTO saved (id, data) VALUES (?, ?)').run(ad.id, JSON.stringify(ad));
  res.json({ ok: true, id: ad.id });

  let changed = false;
  if (ad.videoUrl && !ad.videoUrl.startsWith('/videos/')) {
    const localPath = await downloadVideo(ad.videoUrl, ad.id);
    if (localPath) { ad.videoUrl = localPath; changed = true; }
  }
  if (ad.imageUrl && !ad.imageUrl.startsWith('/images/') && !ad.localImageUrl) {
    const localPath = await downloadImage(ad.imageUrl, ad.id);
    if (localPath) { ad.localImageUrl = localPath; changed = true; }
  }
  if (ad.pageLogo && ad.pageLogo.startsWith('http') && !ad.localPageLogo) {
    const localPath = await downloadImage(ad.pageLogo, ad.id, '-logo');
    if (localPath) { ad.localPageLogo = localPath; changed = true; }
  }
  if (changed) {
    db.prepare('UPDATE saved SET data = ? WHERE id = ?').run(JSON.stringify(ad), ad.id);
  }
});

app.patch('/api/saved/:id', auth, (req, res) => {
  const { analysis } = req.body;
  db.prepare('UPDATE saved SET analysis = ? WHERE id = ?').run(analysis, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/saved/:id', auth, (req, res) => {
  db.prepare('DELETE FROM saved WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/saved', auth, (req, res) => {
  db.prepare('DELETE FROM saved').run();
  res.json({ ok: true });
});

// ─── ANALYZE ──────────────────────────────────────────────────────────────────
app.post('/api/analyze', auth, async (req, res) => {
  const { ad } = req.body || {};
  if (!ad) return res.status(400).json({ error: 'Ad nao fornecido' });
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurado' });

  const prompt = `Voce e um especialista em marketing direto e copywriting. Analise este anuncio do Facebook com visao estrategica e objetiva.

ANUNCIANTE:${ad.advertiser || 'Desconhecido'}
NICHO: ${ad.niche || 'nao informado'}
COPY PRINCIPAL:
${ad.copy || '(sem copy)'}

TITULO DO LINK: ${ad.linkTitle || '(sem titulo)'}
DESCRICAO: ${ad.linkDesc || '(sem descricao)'}

Forneca a analise EXATAMENTE neste formato:

GANCHO: [como o ad prende atencao nos primeiros segundos]

OFERTA: [proposta de valor central e como e comunicada]

COPY: [estrutura e principais tecnicas de persuasao usadas]

PONTOS FORTES: [2 ou 3 elementos que fazem este ad funcionar]

OPORTUNIDADES: [1 ou 2 melhorias que aumentariam a conversao]

NOTA: [X/10] - [justificativa em 1 linha]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `Erro na API do Claude: ${response.status}`, detail: err });
    }

    const data = await response.json();
    const analysis = data.content?.[0]?.text || 'Analise nao disponivel';
    res.json({ analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.1.0' }));

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Offer Hub rodando na porta ${PORT}`);
  // Baixa pageLogos em background após inicializar
  setTimeout(() => migratePageLogos().catch(console.error), 3000);
});
