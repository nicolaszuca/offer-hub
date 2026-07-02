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
const FB_APP_ID = process.env.FB_APP_ID || '';
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';

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
// migrateImageUrls() é chamada após db.exec() criar as tabelas (ver abaixo)

// Migração assíncrona: baixa pageLogo para ads existentes sem arquivo local
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
  CREATE TABLE IF NOT EXISTS domain_stats (
    domain TEXT PRIMARY KEY,
    active_count INTEGER DEFAULT 0,
    checked_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE TABLE IF NOT EXISTS domain_check_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT DEFAULT 'idle',
    requested_at INTEGER,
    finished_at INTEGER
  );
  INSERT OR IGNORE INTO domain_check_state (id, status) VALUES (1, 'idle');
`);

// Executa migrações após as tabelas existirem
migrateImageUrls();

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

// ─── REDIRECT RESOLVER ────────────────────────────────────────────────────────
// Extrai URL destino de l.facebook.com/l.php?u=URL (parâmetro u) sem precisar de HTTP request
function extractFromFbRedirect(url) {
  if (!url || !url.includes('facebook.com')) return null;
  try {
    const u = new URL(url);
    if (u.pathname.includes('/l.php')) {
      const dest = u.searchParams.get('u');
      if (dest && dest.startsWith('http') && !dest.includes('facebook.com')) {
        return dest;
      }
    }
  } catch(e) {}
  return null;
}

// Segue o redirect do l.facebook.com/l.php?u=... até a URL real da VSL/landing page
async function resolveRedirect(url) {
  // Tenta extrair direto do parâmetro u (funciona quando u=https%3A%2F%2F...)
  const direct = extractFromFbRedirect(url);
  if (direct) {
    console.log('[redirect] VSL extraída do parâmetro u:', direct.slice(0, 80));
    return direct;
  }
  // Para tokens opacos (u=AUBv...), o Facebook retorna HTML com a URL destino
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    const finalUrl = res.url;
    // Se o HTTP redirect funcionou diretamente
    if (finalUrl && !finalUrl.includes('facebook.com') && finalUrl.startsWith('http')) {
      console.log('[redirect] VSL via HTTP redirect:', finalUrl.slice(0, 80));
      return finalUrl;
    }
    // Parseia o HTML da página de aviso do Facebook para extrair a URL destino
    const html = await res.text();
    const isFbPage = finalUrl.includes('facebook.com') || finalUrl.includes('l.php');
    if (isFbPage && html) {
      // A página de aviso contém a URL destino em href ou como texto
      const patterns = [
        // <a href="https://external..."> — link de confirmação da página de aviso
        /href="(https?:\/\/(?!(?:www\.)?(?:l\.)?facebook\.com)[^"]{15,800})"/gi,
        // data-url="https://..." em elementos de aviso
        /data-url="(https?:\/\/(?!(?:www\.)?(?:l\.)?facebook\.com)[^"]{15,800})"/gi,
        // JavaScript: location = "url" ou window.location.href = "url"
        /(?:location|location\.href)\s*=\s*["'](https?:\/\/(?!(?:www\.)?(?:l\.)?facebook\.com)[^"']{15,800})["']/gi,
      ];
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
          const candidate = m[1].replace(/&amp;/g, '&');
          if (!candidate.includes('facebook.com') && candidate.startsWith('http')) {
            console.log('[redirect] VSL extraída do HTML:', candidate.slice(0, 80));
            return candidate;
          }
        }
      }
    }
    return null;
  } catch (e) {
    console.warn(`[redirect] Erro ao resolver:`, e.message);
    return null;
  }
}

// CTAs que indicam doação, engajamento social ou ação sem landing page — ignorar
const BLOCKED_CTA = ['donate', 'like', 'follow', 'see more', 'send message', 'call now', 'directions', 'save'];

// Retorna true se o anúncio tem CTA levando para página externa (VSL/landing page)
function hasExternalCta(ad) {
  const ctaRaw = (ad.ctaText || ad.linkTitle || '').toLowerCase().trim();
  if (ctaRaw && BLOCKED_CTA.some(b => ctaRaw === b || ctaRaw.startsWith(b + ' '))) return false;
  if (ad.snapshotUrl && !ad.snapshotUrl.includes('facebook.com')) return true;
  if (ad.linkDesc || ad.linkTitle) return true;
  if (ad.ctaText && ad.ctaText.trim().length > 0) return true;
  if (ad.ctaUrl) return true;
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
  try {
    insertMany(prepared);
  } catch (dbErr) {
    console.error('[queue] Erro ao inserir no banco:', dbErr.message);
    return res.status(500).json({ ok: false, error: dbErr.message });
  }
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
    if (ad.ctaUrl && !ad.vslUrl) {
      resolveRedirect(ad.ctaUrl).then(vslUrl => {
        if (vslUrl) {
          ad.vslUrl = vslUrl;
          db.prepare('UPDATE queue SET data = ? WHERE id = ?').run(JSON.stringify(ad), ad.id);
          console.log(`[redirect] VSL resolvida: ${vslUrl.slice(0, 80)}`);
        }
      });
    }
  }
});

app.delete('/api/queue/:id', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM queue WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete queue] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/queue', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM queue').run();
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete queue all] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── SAVED ────────────────────────────────────────────────────────────────────
app.get('/api/saved', auth, (req, res) => {
  const rows = db.prepare('SELECT id, data, analysis FROM saved ORDER BY saved_at DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, analysis: r.analysis })));
});

app.post('/api/saved', auth, async (req, res) => {
  const ad = req.body;
  if (!ad.id) ad.id = crypto.randomUUID();
  try {
    db.prepare('INSERT OR REPLACE INTO saved (id, data) VALUES (?, ?)').run(ad.id, JSON.stringify(ad));
  } catch (dbErr) {
    console.error('[saved] Erro ao inserir no banco:', dbErr.message);
    return res.status(500).json({ ok: false, error: dbErr.message });
  }
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
  if (ad.ctaUrl && !ad.vslUrl) {
    const vslUrl = await resolveRedirect(ad.ctaUrl);
    if (vslUrl) { ad.vslUrl = vslUrl; changed = true; console.log(`[redirect] VSL resolvida: ${vslUrl.slice(0, 80)}`); }
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
  try {
    db.prepare('DELETE FROM saved WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete saved] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/saved', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM saved').run();
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete saved all] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
// mode=media → apaga só arquivos de imagem/vídeo (libera disco, mantém fila)
// mode=all   → apaga mídia + limpa a fila inteira (padrão antigo)
app.post('/api/cleanup', auth, (req, res) => {
  const mode = req.query.mode || 'all';
  let deleted = 0;
  for (const dir of [IMAGES_DIR, VIDEOS_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); deleted++; } catch (_) {}
      }
    } catch (_) {}
  }
  if (mode === 'all') {
    try {
      db.prepare('DELETE FROM queue').run();
    } catch (e) {
      return res.json({ ok: false, filesDeleted: deleted, error: e.message });
    }
  }
  console.log(`[cleanup] mode=${mode} | ${deleted} arquivos removidos`);
  res.json({ ok: true, filesDeleted: deleted, mode });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    // Tamanho do banco
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'hub.db');
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    // Tamanho das pastas de mídia
    function dirSize(dir) {
      if (!fs.existsSync(dir)) return 0;
      return fs.readdirSync(dir).reduce((acc, f) => {
        try { return acc + fs.statSync(path.join(dir, f)).size; } catch { return acc; }
      }, 0);
    }
    const imagesSize = dirSize(IMAGES_DIR);
    const videosSize = dirSize(VIDEOS_DIR);
    const totalBytes = dbSize + imagesSize + videosSize;
    const toMB = b => (b / 1024 / 1024).toFixed(1);

    // Contagens
    const queueCount = db.prepare('SELECT COUNT(*) as n FROM queue').get().n;
    const savedCount = db.prepare('SELECT COUNT(*) as n FROM saved').get().n;

    res.json({
      ok: true, version: '1.2.0',
      disk: {
        dbMB: toMB(dbSize),
        imagesMB: toMB(imagesSize),
        videosMB: toMB(videosSize),
        totalMB: toMB(totalBytes),
      },
      counts: { queue: queueCount, saved: savedCount },
    });
  } catch (e) {
    res.json({ ok: true, version: '1.2.0', error: e.message });
  }
});

// ─── DOMAIN STATS ─────────────────────────────────────────────────────────────
// Recebe contagem de ads ativos de um domínio (enviado pela extensão)
app.post('/api/domainstat', auth, (req, res) => {
  const { domain, activeCount } = req.body || {};
  if (!domain) return res.status(400).json({ ok: false, error: 'domain obrigatório' });
  try {
    db.prepare(`
      INSERT INTO domain_stats (domain, active_count, checked_at)
      VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(domain) DO UPDATE SET active_count = excluded.active_count, checked_at = excluded.checked_at
    `).run(domain.toLowerCase().trim(), Number(activeCount) || 0);
    console.log(`[domainstat] ${domain}: ${activeCount} ads ativos`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[domainstat] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Retorna todas as estatísticas de domínios
app.get('/api/domainstat', auth, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT domain, active_count, checked_at FROM domain_stats ORDER BY active_count DESC'
    ).all();
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
});

// ─── DOMAIN CHECK STATE ───────────────────────────────────────────────────────
// GET: retorna status atual (idle | pending | running | done)
app.get('/api/domaincheck', auth, (req, res) => {
  try {
    const row = db.prepare(
      'SELECT status, requested_at, finished_at FROM domain_check_state WHERE id = 1'
    ).get();
    res.json(row || { status: 'idle' });
  } catch (e) {
    res.json({ status: 'idle', error: e.message });
  }
});

// POST: atualiza status { action: 'request' | 'start' | 'done' | 'reset' }
app.post('/api/domaincheck', auth, (req, res) => {
  const { action } = req.body || {};
  try {
    if (action === 'request') {
      db.prepare(
        "UPDATE domain_check_state SET status = 'pending', requested_at = strftime('%s','now'), finished_at = NULL WHERE id = 1"
      ).run();
    } else if (action === 'start') {
      db.prepare("UPDATE domain_check_state SET status = 'running' WHERE id = 1").run();
    } else if (action === 'done') {
      db.prepare(
        "UPDATE domain_check_state SET status = 'done', finished_at = strftime('%s','now') WHERE id = 1"
      ).run();
    } else if (action === 'reset') {
      db.prepare("UPDATE domain_check_state SET status = 'idle' WHERE id = 1").run();
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[domaincheck] Erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ─── FACEBOOK AD LIBRARY API ─────────────────────────────────────────────────
async function fetchFbAdCount(domain) {
  const token = `${FB_APP_ID}|${FB_APP_SECRET}`;
  const params = new URLSearchParams({
    access_token: token,
    search_terms: domain,
    ad_active_status: 'ACTIVE',
    ad_reached_countries: '["ALL"]',
    fields: 'id',
    limit: '500',
  });
  let url = `https://graph.facebook.com/v19.0/ads_archive?${params}`;
  let count = 0;
  let pages = 0;
  while (url && pages < 10) {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) {
      console.error(`[fb] API error for ${domain}:`, JSON.stringify(json.error));
      return -1;
    }
    count += (json.data || []).length;
    url = json.paging?.next || null;
    pages++;
  }
  return count;
}

// POST /api/checkdomains — check server-side via Facebook Graph API
app.post('/api/checkdomains', auth, async (req, res) => {
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.status(400).json({ ok: false, error: 'FB_APP_ID e FB_APP_SECRET nao configurados. Adicione nas variaveis de ambiente do Railway.' });
  }

  const allRows = [
    ...db.prepare('SELECT data FROM queue').all(),
    ...db.prepare('SELECT data FROM saved').all(),
  ];
  const domainSet = new Set();
  for (const row of allRows) {
    try {
      const ad = JSON.parse(row.data);
      const d = (ad.linkDomain || '').toLowerCase().trim();
      if (d && !d.includes('facebook') && !d.includes('instagram') && d.length > 3) {
        domainSet.add(d);
      }
    } catch (_) {}
  }
  const domains = Array.from(domainSet);

  if (!domains.length) {
    return res.json({ ok: true, checked: 0, message: 'Nenhum dominio encontrado.' });
  }

  db.prepare("UPDATE domain_check_state SET status = 'running', requested_at = strftime('%s','now'), finished_at = NULL WHERE id = 1").run();
  res.json({ ok: true, checking: domains.length });

  (async () => {
    let ok = 0;
    for (const domain of domains) {
      try {
        const count = await fetchFbAdCount(domain);
        if (count >= 0) {
          db.prepare(`
            INSERT INTO domain_stats (domain, active_count, checked_at)
            VALUES (?, ?, strftime('%s','now'))
            ON CONFLICT(domain) DO UPDATE SET active_count = excluded.active_count, checked_at = excluded.checked_at
          `).run(domain, count);
          console.log(`[fb] ${domain}: ${count} ads ativos`);
          ok++;
        }
      } catch (e) {
        console.warn(`[fb] Erro ao checar ${domain}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
    db.prepare("UPDATE domain_check_state SET status = 'done', finished_at = strftime('%s','now') WHERE id = 1").run();
    console.log(`[fb] Check concluido: ${ok}/${domains.length} dominios atualizados`);
  })().catch(e => {
    console.error('[fb] Erro inesperado:', e.message);
    db.prepare("UPDATE domain_check_state SET status = 'idle' WHERE id = 1").run();
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Offer Hub rodando na porta ${PORT}`);
  // Baixa pageLogos em background após inicializar
  setTimeout(() => migratePageLogos().catch(console.error), 3000);
});
