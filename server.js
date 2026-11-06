#!/usr/bin/env node
'use strict';
/**
 * Mini serveur local pour piloter le bot depuis n8n (ou n'importe quel outil qui sait faire un appel HTTP).
 * Aucune dépendance en plus : module http de Node.
 *
 *   npm run server
 *
 *   GET  /health  -> { ok, busy, lastRun }
 *   POST /run     -> lance un passage, renvoie le rapport (peut durer plusieurs minutes)
 *                    body JSON facultatif : { "dryRun": true, "posts": [ { url, keyword, resourceUrl } ] }
 *   GET  /leads   -> contenu de leads.csv en JSON
 *
 * Variables d'environnement :
 *   PORT       (défaut 3789)
 *   HOST       (défaut 127.0.0.1 ; mets 0.0.0.0 si n8n tourne dans Docker)
 *   BOT_TOKEN  (facultatif : si défini, chaque appel doit envoyer l'en-tête x-bot-token)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');
const { runOnce } = require('./bot');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const PORT = Number(process.env.PORT) || 3789;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.BOT_TOKEN || '';
const LEADS_PATH = path.join(__dirname, 'leads.csv');

let context = null;
let busy = false;
let lastRun = null;

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('fr-FR')}]`, ...a);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
  });
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [header, ...data] = rows;
  return header ? data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) : [];
}

async function getContext() {
  if (context) {
    try { context.pages(); return context; } catch { context = null; }
  }
  // headless: true possible sur un serveur, mais plus facile à détecter : préférer xvfb-run (écran virtuel).
  const headless = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).headless === true;
  context = await launch({ headless });
  context.on('close', () => { context = null; });
  return context;
}

const server = http.createServer(async (req, res) => {
  if (TOKEN && req.headers['x-bot-token'] !== TOKEN) return send(res, 401, { ok: false, error: 'invalid_token' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, busy, lastRun });
  }

  if (req.method === 'GET' && url.pathname === '/leads') {
    const leads = fs.existsSync(LEADS_PATH) ? parseCsv(fs.readFileSync(LEADS_PATH, 'utf8')) : [];
    return send(res, 200, { ok: true, count: leads.length, leads });
  }

  if (req.method === 'POST' && url.pathname === '/run') {
    if (busy) return send(res, 409, { ok: false, error: 'already_running' });
    const body = await readBody(req);
    if (body === null) return send(res, 400, { ok: false, error: 'invalid_json' });
    busy = true;
    log(`▶️  Passage demandé${body.dryRun ? ' (dry run)' : ''}`);
    try {
      const ctx = await getContext();
      const report = await runOnce(ctx, { overrides: body });
      lastRun = { at: new Date().toISOString(), ok: true, events: report.events.length };
      return send(res, 200, { ok: true, ...report });
    } catch (e) {
      const expired = e.message === 'SESSION_EXPIRED';
      lastRun = { at: new Date().toISOString(), ok: false, error: e.message };
      log(expired ? '🔒 Session expirée : lance « npm run login ».' : `⚠️  ${e.message}`);
      return send(res, expired ? 401 : 500, { ok: false, error: expired ? 'session_expired' : e.message });
    } finally {
      busy = false;
    }
  }

  send(res, 404, { ok: false, error: 'not_found' });
});

// Un passage peut durer longtemps (pauses entre les personnes) : pas de délai côté serveur.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  log(`🤖 Bot prêt sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (GET /health, POST /run, GET /leads)`);
  if (HOST !== '127.0.0.1' && !TOKEN) log('⚠️  Le serveur écoute sur le réseau sans BOT_TOKEN : définis-en un.');
});

process.on('SIGINT', async () => {
  log('Arrêt.');
  if (context) await context.close().catch(() => {});
  process.exit(0);
});
