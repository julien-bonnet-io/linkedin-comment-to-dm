#!/usr/bin/env node
'use strict';
/**
 * LinkedIn comment-to-DM bot (Playwright)
 *
 * Pour chaque post de config.json :
 *  1. ouvre le post, charge tous les commentaires
 *  2. garde ceux qui contiennent le mot-clé (une seule fois par personne)
 *  3. visite le profil de chaque personne :
 *     - déjà en relation        -> DM avec la ressource
 *     - t'a envoyé une invitation -> accepte puis DM
 *     - pas en relation          -> invitation (sans note)
 *     - invitation en attente    -> on repassera plus tard
 *  4. répond sous les commentaires traités
 *
 *  npm run dry    -> simulation (visite les profils, n'envoie rien)
 *  npm start      -> un passage
 *  npm run watch  -> tourne en boucle toutes les 12-20 min
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const LEADS_PATH = path.join(ROOT, 'leads.csv');

// ---------------------------------------------------------------- utils
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (min = 800, max = 2200) => sleep(rand(min, max));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const ts = () => new Date().toLocaleTimeString('fr-FR');
const log = (...a) => console.log(`[${ts()}]`, ...a);

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadState() {
  const empty = { delivered: {}, invited: {}, checked: {}, replied: {}, daily: {} };
  try { return { ...empty, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch { return empty; }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function appendLead(row) {
  const header = 'date,post,nom,slug,profil,statut,commentaire\n';
  if (!fs.existsSync(LEADS_PATH)) fs.writeFileSync(LEADS_PATH, header);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ').trim()}"`;
  const line = [new Date().toISOString(), row.post, row.name, row.slug,
    `https://www.linkedin.com/in/${row.slug}/`, row.status, row.text].map(esc).join(',');
  fs.appendFileSync(LEADS_PATH, line + '\n');
}

function postKeyOf(url) {
  const m = url.match(/(\d{19})/);
  return m ? m[1] : url;
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// Un commentaire qui pose une vraie question (ou qui ouvre une discussion) mérite une réponse humaine :
// le bot envoie quand même la ressource en DM, mais ne colle pas de réponse automatique dessous.
function needsHumanReply(cfg, text) {
  const rule = cfg.humanReply || { onQuestion: true, minWords: 25 };
  if (rule.enabled === false) return false;
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return (rule.onQuestion !== false && /\?/.test(text || '')) || (rule.minWords && words >= rule.minWords);
}

// Le commentaire correspond-il à la demande ? posts[].keyword : un mot ou une liste ("" = tout commentaire).
// posts[].match : "contains" (défaut, le mot n'importe où), "word" (mot entier), "exact" (le commentaire
// ne contient que le mot-clé, à la ponctuation et aux emojis près).
function matchesKeyword(post, text) {
  const list = (Array.isArray(post.keyword) ? post.keyword : [post.keyword]).map((k) => norm(k).trim()).filter(Boolean);
  if (!list.length) return true;
  const t = norm(text);
  const mode = post.match || 'contains';
  if (mode === 'exact') {
    const bare = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return list.includes(bare);
  }
  if (mode === 'word') {
    return list.some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(t));
  }
  return list.some((k) => t.includes(k));
}

// Un texte ou une liste de variantes (une tirée au hasard).
const variant = (v) => (Array.isArray(v) ? pick(v) : v);

function inActiveHours(cfg) {
  const [start, end] = cfg.activeHours || [0, 24];
  const h = new Date().getHours();
  return h >= start && h < end;
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

// Tape comme un humain. Les retours à la ligne passent en Shift+Entrée
// (sinon Entrée peut envoyer le message trop tôt).
async function humanType(page, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.type(lines[i], { delay: rand(25, 70) });
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
}

// ---------------------------------------------------------------- selectors
// LinkedIn change régulièrement son HTML : tout est regroupé ici pour corriger vite.
const SEL = {
  comment: 'article.comments-comment-entity, article.comments-comment-item, article[data-id^="urn:li:comment"]',
  commentName: '.comments-comment-meta__description-title, .comments-post-meta__name-text, .comments-comment-item__post-meta .hoverable-link-text',
  commentText: '.comments-comment-item__main-content, .comments-comment-entity__content, .update-components-text',
  loadMore: /load more comments|charger plus de commentaires|afficher plus de commentaires|voir plus de commentaires|more comments/i,
  replyButton: /^(reply|répondre)/i,
  replySubmit: 'button.comments-comment-box__submit-button, button.comments-comment-box__submit-button--cr',
  replySubmitName: /^(reply|répondre|post|publier|comment|commenter)$/i,

  topCard: 'main section',
  distance: '.dist-value, .distance-badge',
  pending: /^(pending|en attente)/i,
  accept: /^(accept|accepter)/i,
  connect: /(invite .* to connect|inviter .* à rejoindre|^connect$|^se connecter$)/i,
  more: /^(more|plus)( actions| d.actions)?$/i,
  menu: '.artdeco-dropdown__content--is-open, [role="menu"]',
  sendWithoutNote: /(send without a note|envoyer sans note)/i,
  sendInvite: /^(send|envoyer)( now| maintenant)?$/i,
  messageButton: /^\s*(message|envoyer un message)\b/i,

  msgBox: '.msg-form__contenteditable[contenteditable="true"]',
  msgSend: 'button.msg-form__send-button, button.msg-form__send-btn',
  msgHistory: '.msg-s-message-list-content, .msg-s-message-list',
  msgClose: /(close your conversation|fermer votre conversation|close conversation|fermer la conversation)/i,
};

// ---------------------------------------------------------------- post page
async function ensureLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await pause(1500, 3000);
  if (/\/(login|checkpoint|authwall|uas\/login)/.test(page.url())) {
    throw new Error('SESSION_EXPIRED');
  }
}

async function openPost(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SEL.comment, { timeout: 20000 }).catch(() => {});
  await pause(1500, 3000);
  await loadAllComments(page);
}

async function loadAllComments(page) {
  for (let i = 0; i < 40; i++) {
    const btn = page.locator('button').filter({ hasText: SEL.loadMore }).first();
    if (!(await isVisible(btn))) {
      await page.mouse.wheel(0, rand(1500, 2500));
      await pause(900, 1600);
      if (!(await isVisible(btn))) break;
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click().catch(() => {});
    await pause(1200, 2500);
  }
}

async function extractComments(page) {
  return page.$$eval(SEL.comment, (els, s) => els.map((el) => {
    const a = el.querySelector('a[href*="/in/"]');
    const href = a ? a.href : '';
    const m = href.match(/\/in\/([^/?#]+)/);
    const nameEl = el.querySelector(s.commentName);
    const textEl = el.querySelector(s.commentText);
    const rawName = (nameEl ? nameEl.innerText : (a ? a.innerText : '')) || '';
    const name = rawName.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
    return {
      id: el.getAttribute('data-id') || '',
      slug: m ? decodeURIComponent(m[1]) : null,
      name: name.replace(/\s*[•·].*$/, '').trim(),
      text: (textEl ? textEl.innerText : '').trim(),
    };
  }), { commentName: SEL.commentName, commentText: SEL.commentText });
}

function commentLocator(page, c) {
  if (c.id) return page.locator(`article[data-id="${c.id}"]`).first();
  return page.locator(SEL.comment)
    .filter({ has: page.locator(`a[href*="/in/${c.slug}"]`) })
    .filter({ hasText: c.text.slice(0, 40) })
    .last();
}

async function replyToComment(page, c, text) {
  const box = commentLocator(page, c);
  if (!(await isVisible(box))) return false;
  await box.scrollIntoViewIfNeeded();
  await pause();
  await box.getByRole('button', { name: SEL.replyButton }).first().click();
  await pause(1000, 1800);
  const editor = box.locator('[contenteditable="true"]').last();
  await editor.waitFor({ timeout: 8000 });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ' + text, { delay: rand(25, 70) });
  await pause(700, 1400);
  let submit = box.locator(SEL.replySubmit).last();
  if (!(await isVisible(submit))) submit = box.getByRole('button', { name: SEL.replySubmitName }).last();
  await submit.click();
  await pause(1500, 2500);
  return true;
}

// ---------------------------------------------------------------- profile page
async function openProfile(page, slug) {
  await page.goto(`https://www.linkedin.com/in/${slug}/`, { waitUntil: 'domcontentloaded' });
  await page.locator(SEL.topCard).first().waitFor({ timeout: 20000 });
  await pause(1500, 3500);
}

async function readMoreMenu(page, top) {
  const more = top.getByRole('button', { name: SEL.more }).first();
  if (!(await isVisible(more))) return '';
  await more.click();
  await pause(600, 1200);
  const text = await page.locator(SEL.menu).first().innerText().catch(() => '');
  await page.keyboard.press('Escape');
  await pause(300, 700);
  return text;
}

// -> 'connected' | 'pending' | 'incoming' | 'not_connected' | 'unknown'
async function getRelation(page) {
  const top = page.locator(SEL.topCard).first();
  const btn = (re) => top.getByRole('button', { name: re }).first();
  if (await isVisible(btn(SEL.pending))) return 'pending';
  if (await isVisible(btn(SEL.accept))) return 'incoming';
  if (await isVisible(btn(SEL.connect))) return 'not_connected';
  const dist = (await top.locator(SEL.distance).first().innerText().catch(() => '')).trim();
  if (/^(1st|1er)/i.test(dist)) return 'connected';
  const menu = await readMoreMenu(page, top);
  if (/(remove connection|retirer la relation|supprimer la relation)/i.test(menu)) return 'connected';
  if (/(pending|en attente|withdraw|retirer l.invitation)/i.test(menu)) return 'pending';
  if (/(^|\n)\s*(connect|se connecter)\s*($|\n)/i.test(menu)) return 'not_connected';
  return 'unknown';
}

async function acceptInvite(page) {
  const top = page.locator(SEL.topCard).first();
  await top.getByRole('button', { name: SEL.accept }).first().click();
  await pause(2000, 3500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pause(2000, 3500);
  return (await getRelation(page)) === 'connected';
}

async function sendInvite(page) {
  const top = page.locator(SEL.topCard).first();
  let connect = top.getByRole('button', { name: SEL.connect }).first();
  if (!(await isVisible(connect))) {
    await top.getByRole('button', { name: SEL.more }).first().click();
    await pause(600, 1200);
    const menu = page.locator(SEL.menu).first();
    connect = menu.getByRole('button', { name: SEL.connect }).first();
    if (!(await isVisible(connect))) connect = menu.getByText(/^(connect|se connecter)$/i).first();
  }
  await connect.click();
  await pause(1200, 2200);
  const dialog = page.getByRole('dialog').last();
  const noNote = dialog.getByRole('button', { name: SEL.sendWithoutNote }).first();
  const send = dialog.getByRole('button', { name: SEL.sendInvite }).first();
  if (await isVisible(noNote)) await noNote.click();
  else if (await isVisible(send)) await send.click();
  else { await page.keyboard.press('Escape'); return false; } // ex : LinkedIn demande l'email
  await pause(1500, 2500);
  return (await getRelation(page)) === 'pending';
}

// -> 'sent' | 'already' | 'failed'
async function sendDM(page, text, resourceUrl) {
  const top = page.locator(SEL.topCard).first();
  const msg = top.locator('button, a').filter({ hasText: SEL.messageButton }).first();
  if (!(await isVisible(msg))) return 'failed';
  await msg.click();
  const box = page.locator(SEL.msgBox).last();
  await box.waitFor({ timeout: 15000 });
  await pause(1500, 2500);

  // Filet de sécurité : si le lien a déjà été envoyé dans cette conversation, on n'envoie pas.
  const history = await page.locator(SEL.msgHistory).last().innerText().catch(() => '');
  if (resourceUrl && history.includes(resourceUrl)) { await closeConversation(page); return 'already'; }

  await box.click();
  await humanType(page, text);
  await pause(800, 1500);
  const sendBtn = page.locator(SEL.msgSend).last();
  if (await sendBtn.isEnabled().catch(() => false)) await sendBtn.click();
  else await page.keyboard.press('Enter');
  await pause(1800, 3000);
  await closeConversation(page);
  return 'sent';
}

async function closeConversation(page) {
  const close = page.getByRole('button', { name: SEL.msgClose }).last();
  if (await isVisible(close)) await close.click().catch(() => {});
  await pause(500, 1000);
}

// ---------------------------------------------------------------- main run
// overrides : { dryRun, posts } envoyés par n8n (POST /run) pour remplacer config.json le temps d'un passage.
// Renvoie un rapport structuré : ce qui a été vu et fait, personne par personne.
async function runOnce(context, { dryRunFlag = false, overrides = {} } = {}) {
  const cfg = { ...loadConfig() };
  if (Array.isArray(overrides.posts) && overrides.posts.length) cfg.posts = overrides.posts;
  if (typeof overrides.dryRun === 'boolean') cfg.dryRun = overrides.dryRun;
  const dry = dryRunFlag || cfg.dryRun === true;
  const report = { startedAt: new Date().toISOString(), dryRun: dry, skipped: null, posts: [], events: [], counters: null };
  const event = (post, c, action, detail = '') => report.events.push({
    post, action, name: c.name || '', slug: c.slug, profileUrl: `https://www.linkedin.com/in/${c.slug}/`, comment: c.text, detail,
  });
  if (!inActiveHours(cfg)) {
    log(`⏸  Hors plage horaire (${cfg.activeHours.join('h-')}h), rien à faire.`);
    report.skipped = 'outside_active_hours';
    return report;
  }

  const state = loadState();
  const day = today();
  state.daily[day] = state.daily[day] || { dm: 0, invite: 0 };
  const counters = state.daily[day];
  const page = context.pages()[0] || (await context.newPage());

  log(dry ? '🧪 DRY RUN : rien ne sera envoyé.' : '🚀 Passage réel.');
  await ensureLoggedIn(page);

  for (const post of cfg.posts.filter((p) => p.active !== false)) {
    const postKey = postKeyOf(post.url);
    log(`📄 Post ${postKey} | mot-clé « ${post.keyword} »`);
    await openPost(page, post.url);

    const all = await extractComments(page);
    const seen = new Set();
    const matches = all.filter((c) => {
      if (!c.slug || c.slug === cfg.mySlug || seen.has(c.slug)) return false;
      if (!matchesKeyword(post, c.text)) return false;
      seen.add(c.slug);
      return true;
    });

    const now = Date.now();
    const recheckMs = (cfg.recheckPendingEveryMinutes || 60) * 60e3;
    const giveUpMs = (cfg.stopRecheckingAfterDays || 21) * 86400e3;
    const todo = matches.filter((c) => {
      const key = `${postKey}|${c.slug}`;
      if (state.delivered[key]) return false;
      const inv = state.invited[key];
      if (inv && now - Date.parse(inv) > giveUpMs) return false;
      const last = state.checked[key];
      if (last && now - Date.parse(last) < recheckMs) return false;
      return true;
    });
    // Les nouveaux d'abord, les invitations en attente ensuite
    todo.sort((a, b) => Number(!!state.invited[`${postKey}|${a.slug}`]) - Number(!!state.invited[`${postKey}|${b.slug}`]));

    log(`   ${all.length} commentaires, ${matches.length} avec le mot-clé, ${todo.length} à traiter.`);
    report.posts.push({ post: postKey, url: post.url, keyword: post.keyword, comments: all.length, matches: matches.length, toProcess: todo.length });

    const replies = [];
    let visits = 0;
    for (const c of todo) {
      if (visits >= (cfg.maxProfileVisitsPerRun || 15)) { log('   Limite de visites atteinte pour ce passage.'); break; }
      const key = `${postKey}|${c.slug}`;
      const firstName = (c.name.split(' ')[0] || '').trim();

      if (visits > 0) {
        const [dMin, dMax] = cfg.delayBetweenPeopleSeconds || [40, 110];
        await sleep(rand(dry ? Math.ceil(dMin / 3) : dMin, dry ? Math.ceil(dMax / 3) : dMax) * 1000);
      }

      try {
        await openProfile(page, c.slug);
        visits++;
        if (!dry) state.checked[key] = new Date().toISOString(); // un dry run ne modifie pas la mémoire
        let rel = await getRelation(page);
        log(`   👤 ${c.name || c.slug} -> ${rel}`);

        if (rel === 'incoming') {
          if (dry || !cfg.acceptIncomingInvites) { log('      (dry) accepterait son invitation puis enverrait le DM'); event(postKey, c, 'would_accept_and_dm'); continue; }
          rel = (await acceptInvite(page)) ? 'connected' : 'unknown';
          log(`      invitation acceptée -> ${rel}`);
          event(postKey, c, 'invite_accepted', rel);
        }

        if (rel === 'connected') {
          if (dry) { log('      (dry) enverrait le DM'); event(postKey, c, 'would_dm'); continue; }
          if (counters.dm >= cfg.dailyMaxDMs) { log('   Quota DM du jour atteint.'); event(postKey, c, 'daily_dm_limit'); break; }
          // Message différent pour les nouvelles relations (invitation acceptée), s'il est défini.
          const tpl = state.invited[key] && cfg.messages.dmNewConnection ? cfg.messages.dmNewConnection : cfg.messages.dm;
          const text = fill(variant(tpl), { firstName, resourceUrl: post.resourceUrl });
          const res = await sendDM(page, text, post.resourceUrl);
          log(`      DM -> ${res}`);
          event(postKey, c, res === 'sent' ? 'dm_sent' : res === 'already' ? 'already_received' : 'dm_failed');
          if (res === 'sent' || res === 'already') {
            state.delivered[key] = new Date().toISOString();
            if (res === 'sent') { counters.dm++; replies.push({ c, key, type: 'dm' }); }
            appendLead({ post: postKey, name: c.name, slug: c.slug, status: res === 'sent' ? 'dm_envoye' : 'deja_recu', text: c.text });
          }
        } else if (rel === 'pending') {
          if (!state.invited[key]) state.invited[key] = new Date().toISOString();
          log('      invitation en attente, on repassera.');
          event(postKey, c, 'invite_pending');
        } else if (rel === 'not_connected') {
          if (state.invited[key]) { log('      déjà invité(e) mais plus en attente (refus ?), on laisse.'); event(postKey, c, 'invite_declined'); continue; }
          if (dry) { log('      (dry) enverrait une invitation'); event(postKey, c, 'would_invite'); continue; }
          if (counters.invite >= cfg.dailyMaxInvites) { log('   Quota invitations du jour atteint.'); event(postKey, c, 'daily_invite_limit'); continue; }
          const ok = await sendInvite(page);
          log(`      invitation -> ${ok ? 'envoyée' : 'échec'}`);
          event(postKey, c, ok ? 'invited' : 'invite_failed');
          if (ok) {
            state.invited[key] = new Date().toISOString();
            counters.invite++;
            replies.push({ c, key, type: 'invite' });
            appendLead({ post: postKey, name: c.name, slug: c.slug, status: 'invite', text: c.text });
          }
        } else {
          event(postKey, c, 'unknown_relation');
        }
      } catch (e) {
        log(`      ⚠️  erreur sur ${c.slug} : ${e.message.split('\n')[0]}`);
        event(postKey, c, 'error', e.message.split('\n')[0]);
      } finally {
        if (!dry) saveState(state);
      }
    }

    if (!dry && cfg.replyToComments && replies.length) {
      log(`   💬 Réponses sous ${replies.length} commentaire(s)...`);
      await openPost(page, post.url);
      for (const r of replies) {
        const rkey = `${r.key}|${r.type}`;
        if (state.replied[rkey]) continue;
        if (needsHumanReply(cfg, r.c.text)) {
          log(`      ${r.c.name || r.c.slug} -> vraie question ou long commentaire : réponse à faire toi-même`);
          event(postKey, r.c, 'needs_human_reply', r.type);
          state.replied[rkey] = 'human';
          saveState(state);
          continue;
        }
        const text = pick(r.type === 'dm' ? cfg.messages.replyDm : cfg.messages.replyInvite);
        try {
          const ok = await replyToComment(page, r.c, fill(text, { firstName: (r.c.name.split(' ')[0] || '') }));
          if (ok) state.replied[rkey] = new Date().toISOString();
          log(`      ${r.c.name || r.c.slug} -> ${ok ? 'répondu' : 'commentaire introuvable'}`);
          event(postKey, r.c, ok ? 'comment_replied' : 'comment_not_found', r.type);
        } catch (e) {
          log(`      ⚠️  réponse impossible (${r.c.slug}) : ${e.message.split('\n')[0]}`);
        }
        saveState(state);
        await sleep(rand(15, 45) * 1000);
      }
    }
  }
  log(`✅ Fini. Aujourd'hui : ${counters.dm} DM, ${counters.invite} invitations.`);
  report.counters = { date: day, ...counters };
  report.finishedAt = new Date().toISOString();
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const dryRunFlag = args.includes('--dry-run');
  const cfg = loadConfig();
  const context = await launch({ headless: cfg.headless === true });
  const stop = async () => { log('Arrêt.'); await context.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop);

  do {
    try {
      await runOnce(context, { dryRunFlag });
    } catch (e) {
      if (e.message === 'SESSION_EXPIRED') {
        log('🔒 Session LinkedIn expirée ou checkpoint. Lance « npm run login » puis relance.');
        break;
      }
      log('⚠️  Erreur :', e.message);
    }
    if (!watch) break;
    const [wMin, wMax] = loadConfig().watchIntervalMinutes || [12, 20];
    const wait = rand(wMin, wMax);
    log(`😴 Prochain passage dans ${wait} min (Ctrl+C pour arrêter).`);
    await sleep(wait * 60e3);
  } while (true);

  await context.close().catch(() => {});
}

if (require.main === module) main();

module.exports = { extractComments, getRelation, sendDM, sendInvite, acceptInvite, replyToComment, loadAllComments, runOnce, SEL };
