const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.HUB_PASSWORD || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';

// DATABASE
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

// AUTH
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

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// AUTH ROUTE
app.post('/api/auth', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ token: 'no-auth' });
  const { password } = req.body || {};
  if (!password || password !== PASSWORD) return res.status(401).json({ error: 'Senha incorreta' });
  res.json({ token: getToken() });
});

// QUEUE
app.get('/api/queue', auth, (req, res) => {
  const rows = db.prepare('SELECT id, data FROM queue ORDER BY created_at ASC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});

app.post('/api/queue', auth, (req, res) => {
  const ads = Array.isArray(req.body) ? req.body : [req.body];
  const insert = db.prepare('INSERT OR IGNORE INTO queue (id, data) VALUES (?, ?)');
  const insertMany = db.transaction((items) => {
    for (const ad of items) {
      if (!ad.id) ad.id = crypto.randomUUID();
      insert.run(ad.id, JSON.stringify(ad));
    }
  });
  insertMany(ads);
  res.json({ ok: true, count: ads.length });
});

app.delete('/api/queue/:id', auth, (req, res) => {
  db.prepare('DELETE FROM queue WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/queue', auth, (req, res) => {
  db.prepare('DELETE FROM queue').run();
  res.json({ ok: true });
});

// SAVED
app.get('/api/saved', auth, (req, res) => {
  const rows = db.prepare('SELECT id, data, analysis FROM saved ORDER BY saved_at DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, analysis: r.analysis })));
});

app.post('/api/saved', auth, (req, res) => {
  const ad = req.body;
  if (!ad.id) ad.id = crypto.randomUUID();
  db.prepare('INSERT OR REPLACE INTO saved (id, data) VALUES (?, ?)').run(ad.id, JSON.stringify(ad));
  res.json({ ok: true, id: ad.id });
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

// ANÁLISE IA
app.post('/api/analyze', auth, async (req, res) => {
  const { ad } = req.body || {};
  if (!ad) return res.status(400).json({ error: 'Ad não fornecido' });
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurado' });

  const prompt = `Você é um especialista em marketing direto e copywriting. Analise este anúncio do Facebook com visão estratégica e objetiva.

ANUNCIANTE: ${ad.advertiser || 'Desconhecido'}
COPY PRINCIPAL:
${ad.copy || '(sem copy)'}

TÍTULO DO LINK: ${ad.linkTitle || '(sem título)'}
DESCRIÇÃO: ${ad.linkDesc || '(sem descrição)'}
PLATAFORMAS: ${(ad.platforms || []).join(', ') || 'não informado'}

Forneça a análise EXATAMENTE neste formato (máximo 2 linhas por seção):

🎣 GANCHO: [como o ad prende atenção nos primeiros segundos]

💎 OFERTA: [proposta de valor central e como é comunicada]

✍️ COPY: [estrutura e principais técnicas de persuasão usadas]

⚡ PONTOS FORTES: [2 ou 3 elementos que fazem este ad funcionar]

⚠️ OPORTUNIDADES: [1 ou 2 melhorias que aumentariam a conversão]

⭐ NOTA: [X/10] — [justificativa em 1 linha]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) { const err = await response.text(); return res.status(502).json({ error: `Erro Claude API: ${response.status}`, detail: err }); }
    const data = await response.json();
    res.json({ analysis: data.content?.[0]?.text || 'Análise não disponível' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HEALTH
app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

app.listen(PORT, () => {
  console.log(`✅ Offer Hub rodando em http://localhost:${PORT}`);
  if (!CLAUDE_KEY) console.warn('⚠️  ANTHROPIC_API_KEY não definido — análise IA desativada');
});
