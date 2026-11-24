// Levanter Hosting Panel v1
// A tiny self-hosted panel: deploy and manage Levanter WhatsApp bots on one VPS.
// Stack: Node.js + Express only. Data lives in bots.json. No database, no build step.
//
// How it works:
//  - Admin logs in once (password in .env, generated on first run).
//  - Deploy form clones https://github.com/lyfe00011/levanter.git into bots/<name>/,
//    runs npm install, writes config.env, then starts the bot with `node index.js`.
//  - Each bot runs as a detached child process; its stdout/stderr go to bots/<name>/bot.log.
//  - Capacity is read from /proc/meminfo; a new deploy is refused when less than
//    ~300 MB of free RAM would remain (each bot uses about 270 MB).

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const DATA_FILE = path.join(ROOT, 'bots.json');
const BOTS_DIR = process.env.BOTS_DIR
  ? path.resolve(process.env.BOTS_DIR)
  : path.join(ROOT, 'bots');
const PORT = parseInt(process.env.PORT || '3000', 10);
const LEVANTER_REPO = 'https://github.com/lyfe00011/levanter.git';
const BOT_RAM_MB = 270;      // typical RAM use of one Levanter bot
const RESERVE_MB = 300;      // free RAM that must remain after a new deploy
const NPM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for npm install

// ---------------------------------------------------------------------------
// Tiny .env loader (no dotenv dependency). Only KEY=VALUE lines are read.
// ---------------------------------------------------------------------------
function loadEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const fileEnv = loadEnvFile();

// Admin password: env var wins, then .env file, otherwise generate one once
// and save it to .env. It is NEVER printed to the console or to any page.
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || fileEnv.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(18).toString('base64url');
  fs.appendFileSync(ENV_FILE, `ADMIN_PASSWORD=${ADMIN_PASSWORD}\n`, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { /* best effort */ }
  console.log('[panel] First run: a random admin password was generated and saved to .env');
  console.log('[panel] Open .env on this server to see it. It is never printed here.');
}

// ---------------------------------------------------------------------------
// Bot store (bots.json). Session IDs live here so a bot can be restarted
// without asking again. The file holds secrets: keep it 0600 and never send
// session IDs to the browser.
// ---------------------------------------------------------------------------
function loadBots() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(data)) return data;
  } catch (e) { /* missing or broken file -> start empty */ }
  return [];
}
function saveBots() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bots, null, 2), { mode: 0o600 });
  try { fs.chmodSync(DATA_FILE, 0o600); } catch (e) { /* best effort */ }
}
let bots = loadBots();
fs.mkdirSync(BOTS_DIR, { recursive: true });

// In-memory sessions: token -> createdAt. A server restart logs everyone out.
const sessions = new Map();
function newSessionToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

// ---------------------------------------------------------------------------
// System helpers
// ---------------------------------------------------------------------------
function readMeminfo() {
  // Returns { totalMB, availableMB } from /proc/meminfo (Linux only).
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = txt.match(new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm'));
      return m ? Math.round(parseInt(m[1], 10) / 1024) : 0;
    };
    return { totalMB: get('MemTotal'), availableMB: get('MemAvailable') };
  } catch (e) {
    return { totalMB: 0, availableMB: 0 };
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function pidRssMB(pid) {
  // Resident memory of a process, in MB. Returns 0 when unreadable.
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = txt.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : 0;
  } catch (e) { return 0; }
}

function botDir(name) { return path.join(BOTS_DIR, name); }
function botLogFile(name) { return path.join(botDir(name), 'bot.log'); }
function findBot(name) { return bots.find((b) => b.name === name); }

// Refresh a bot's live status from its PID. A process that died on its own
// (crash, WhatsApp disconnect loop, OOM) shows as stopped.
function liveStatus(bot) {
  if (bot.pid && pidAlive(bot.pid)) {
    return { status: 'running', pid: bot.pid, ramMB: pidRssMB(bot.pid) };
  }
  return { status: 'stopped', pid: null, ramMB: 0 };
}

function refreshBot(bot) {
  const live = liveStatus(bot);
  if (live.status === 'stopped' && bot.status === 'running') {
    bot.status = 'stopped';
    bot.pid = null;
    bot.startedAt = null;
    saveBots();
  }
  return live;
}

// ---------------------------------------------------------------------------
// Bot process control
// ---------------------------------------------------------------------------
function startBot(bot) {
  const dir = botDir(bot.name);
  const logPath = botLogFile(bot.name);
  if (!fs.existsSync(path.join(dir, 'index.js'))) {
    throw new Error('index.js not found — deploy did not finish. Delete and deploy again.');
  }
  const out = fs.openSync(logPath, 'a');
  const child = spawn('node', ['index.js'], {
    cwd: dir,
    detached: true,          // survives even if the panel restarts
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  fs.closeSync(out);
  child.unref();
  child.on('error', () => { /* start failure is visible via status, not a crash */ });
  bot.pid = child.pid;
  bot.status = 'running';
  bot.startedAt = Date.now();
  saveBots();
  return child.pid;
}

function stopBot(bot, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!bot.pid || !pidAlive(bot.pid)) {
      bot.pid = null; bot.status = 'stopped'; bot.startedAt = null; saveBots();
      return resolve(true);
    }
    const pid = bot.pid;
    try { process.kill(-pid, 'SIGTERM'); } catch (e) { try { process.kill(pid, 'SIGTERM'); } catch (e2) {} }
    const start = Date.now();
    const timer = setInterval(() => {
      if (!pidAlive(pid) || Date.now() - start > timeoutMs) {
        clearInterval(timer);
        if (pidAlive(pid)) {
          try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
        }
        bot.pid = null; bot.status = 'stopped'; bot.startedAt = null; saveBots();
        resolve(true);
      }
    }, 300);
  });
}

function readLastLines(file, n) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    const lines = data.split('\n');
    // Drop a trailing empty line, keep the last n.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).join('\n');
  } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// Deploy jobs (run in the background; the browser polls for progress)
// ---------------------------------------------------------------------------
const deployJobs = new Map(); // jobId -> { name, step, message, done, error, log }
let jobCounter = 0;

function runCommand(cmd, args, cwd, logFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logStream.write(d));
    child.stderr.on('data', (d) => logStream.write(d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end();
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code} (see deploy log)`));
    });
  });
}

async function runDeploy(job, input) {
  const { name, sessionId, sudo, prefix, owner } = input;
  const dir = botDir(name);
  const deployLog = path.join(dir, 'deploy.log');
  const step = (s, m) => { job.step = s; job.message = m; };
  try {
    step('prepare', 'Creating bot folder…');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(deployLog, `Deploy of "${name}" started ${new Date().toISOString()}\n`);

    step('clone', 'Cloning Levanter from GitHub (shallow clone)…');
    await runCommand('git', ['clone', '--depth', '1', LEVANTER_REPO, dir + '-tmp'], ROOT, deployLog, 5 * 60 * 1000);
    // Move the clone into place (git refuses to clone into a non-empty dir).
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(dir + '-tmp', dir);

    step('install', 'Running npm install — this can take a few minutes…');
    try {
      await runCommand('npm', ['install', '--no-audit', '--no-fund'], dir, deployLog, NPM_TIMEOUT_MS);
    } catch (err) {
      // Levanter's own dependency tree has a peer conflict (baileys wants
      // jimp ^1.6, the project pins jimp ^0.16) and plain npm install fails
      // with ERESOLVE. npm itself suggests --legacy-peer-deps, so retry once
      // with it instead of failing the whole deploy.
      fs.appendFileSync(deployLog, '\nFirst npm install failed; retrying with --legacy-peer-deps…\n');
      job.message = 'npm install hit a dependency conflict — retrying with --legacy-peer-deps…';
      await runCommand('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], dir, deployLog, NPM_TIMEOUT_MS);
    }

    step('config', 'Writing config.env…');
    const envLines = [
      `SESSION_ID=${sessionId}`,
      `SUDO=${sudo}`,
      `PREFIX=${prefix}`,
      'VPS=true',
    ];
    if (owner) envLines.push(`OWNER_NUMBER=${owner}`);
    fs.writeFileSync(path.join(dir, 'config.env'), envLines.join('\n') + '\n', { mode: 0o600 });

    step('start', 'Starting the bot…');
    const bot = {
      name, sudo, prefix, owner: owner || '',
      sessionId, // kept server-side only; never sent to the browser
      status: 'stopped', pid: null, startedAt: null,
      createdAt: Date.now(),
    };
    bots.push(bot);
    saveBots();
    try {
      startBot(bot);
      job.message = 'Bot started. Check the logs — with a wrong or expired session ID it will fail to connect, which is normal.';
    } catch (err) {
      job.message = 'Files are ready but the bot could not start: ' + err.message;
    }
    job.step = 'done';
    job.done = true;
  } catch (err) {
    job.step = 'error';
    job.error = err.message;
    job.done = true;
    try { fs.appendFileSync(deployLog, `\nDEPLOY FAILED: ${err.message}\n`); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function requireAuth(req, res, next) {
  const token = parseCookies(req).session;
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  return res.redirect('/login');
}

// ---------------------------------------------------------------------------
// HTML pages (server-rendered, no external CDN — everything local)
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtUptime(startedAt) {
  if (!startedAt) return '—';
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Levanter Bot Hosting by AYAN XD</title>
<link rel="stylesheet" href="/style.css"></head>
<body><div class="wrap">
<header><a class="brand" href="/"><span class="brand-mark">⚡</span><span><span class="brand-name">Levanter <em>Bot Hosting</em></span><br><span class="brand-by">by AYAN XD</span></span></a>
<nav><a href="/dashboard">Dashboard</a> <a href="/deploy">+ Deploy bot</a>
<form method="post" action="/logout" style="display:inline"><button class="linklike" type="submit">Log out</button></form></nav></header>
${body}</div></body></html>`;
}
function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — Levanter Bot Hosting by AYAN XD</title>
<link rel="stylesheet" href="/style.css"></head>
<body><div class="wrap narrow">
<div class="login-card">
<a class="brand" href="/" style="justify-content:center"><span class="brand-mark">⚡</span><span><span class="brand-name">Levanter <em>Bot Hosting</em></span><br><span class="brand-by">by AYAN XD</span></span></a>
<h1>Admin <span>Login</span></h1>
<p class="muted">The password is stored in <code>.env</code> on this server.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<label style="text-align:left">Admin password<br><input type="password" name="password" required autofocus></label>
<button type="submit">Log in</button></form>
<p class="muted small" style="margin-top:14px">Developed by <strong style="color:var(--gold)">AYAN XD</strong></p>
</div></div></body></html>`;
}

// Public landing page (no login needed): hero, features, how it works.
function landingPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Levanter Bot Hosting by AYAN XD</title>
<link rel="stylesheet" href="/style.css"></head>
<body><div class="wrap">
<header><a class="brand" href="/"><span class="brand-mark">⚡</span><span><span class="brand-name">Levanter <em>Bot Hosting</em></span><br><span class="brand-by">by AYAN XD</span></span></a>
<nav><a href="/login">Login</a></nav></header>
<section class="hero">
  <span class="eyebrow">Free · Self-hosted · 24/7</span>
  <h1>Levanter <span class="gold">Bot Hosting</span></h1>
  <p class="tagline">Deploy your Levanter WhatsApp bot in seconds. Paste your session ID, set your SUDO numbers, and your bot runs around the clock — no card, no setup pain.</p>
  <div class="cta">
    <a class="btn btn-gold" href="/login">Deploy Your Bot ⚡</a>
    <a class="btn btn-ghost" href="/login">Login</a>
  </div>
</section>
<h2 class="features-title">Why host here?</h2>
<div class="features">
  <div class="feature"><div class="icon">🆓</div><h3><span>100% Free</span></h3><p>No card, no trial clock, no hidden charges. Deploy as many bots as the server's RAM allows.</p></div>
  <div class="feature"><div class="icon">💾</div><h3><span>1 GB RAM per bot</span></h3><p>Every bot gets a full gigabyte of room to breathe, with a live capacity meter so you always know what's free.</p></div>
  <div class="feature"><div class="icon">⚡</div><h3><span>Deploy in seconds</span></h3><p>Paste your session ID, SUDO numbers and prefix — the panel clones Levanter, installs it and starts your bot for you.</p></div>
  <div class="feature"><div class="icon">📜</div><h3><span>Live logs</span></h3><p>Watch your bot's last 200 log lines right from the dashboard. Session IDs are never shown in logs.</p></div>
  <div class="feature"><div class="icon">🎛️</div><h3><span>Full control</span></h3><p>Start, stop, restart or delete any bot with one click — no terminal, no SSH needed.</p></div>
  <div class="feature"><div class="icon">📊</div><h3><span>Capacity meter</span></h3><p>Real RAM usage per bot, straight from the host. New deploys pause automatically when the server fills up.</p></div>
</div>
<section class="steps">
  <h2>How it works</h2>
  <div class="step"><span class="step-num">1</span><div><h3>Get your session ID</h3><p>Pair Levanter once and copy the session ID it gives you.</p></div></div>
  <div class="step"><span class="step-num">2</span><div><h3>Paste it here</h3><p>Log in, open Deploy, paste the session ID with your SUDO numbers and command prefix.</p></div></div>
  <div class="step"><span class="step-num">3</span><div><h3>Your bot runs 24/7</h3><p>The panel installs Levanter and starts your bot. Check its status and logs anytime from the dashboard.</p></div></div>
</section>
<div style="text-align:center;margin:28px 0"><a class="btn btn-gold" href="/login">Deploy Your Bot ⚡</a></div>
<footer class="landing-footer">Developed by <strong>AYAN XD</strong> · Levanter Bot Hosting · Free forever</footer>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/', (req, res) => res.send(landingPage()));

app.get('/login', (req, res) => res.send(loginPage('')));

app.post('/login', (req, res) => {
  const pw = req.body.password || '';
  // Constant-time-ish compare to avoid trivial timing leaks.
  const a = Buffer.from(pw);
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).send(loginPage('Wrong password. Try again.'));
  const token = newSessionToken();
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => {
  const token = parseCookies(req).session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/dashboard', requireAuth, (req, res) => {
  const mem = readMeminfo();
  let usedMB = 0;
  const rows = bots.map((bot) => {
    const live = refreshBot(bot);
    usedMB += live.ramMB;
    const status = live.status === 'running'
      ? `<span class="pill on">● running</span>`
      : `<span class="pill off">○ stopped</span>`;
    return `<tr>
      <td><strong>${esc(bot.name)}</strong><br><span class="muted small">prefix ${esc(bot.prefix)} · sudo ${esc(bot.sudo)}</span></td>
      <td>${status}</td>
      <td>${fmtUptime(bot.startedAt)}</td>
      <td>${live.ramMB ? live.ramMB + ' MB' : '—'}</td>
      <td class="actions">
        <button data-act="start" data-name="${esc(bot.name)}" ${live.status === 'running' ? 'disabled' : ''}>Start</button>
        <button data-act="stop" data-name="${esc(bot.name)}" ${live.status !== 'running' ? 'disabled' : ''}>Stop</button>
        <button data-act="restart" data-name="${esc(bot.name)}">Restart</button>
        <button data-act="logs" data-name="${esc(bot.name)}">Logs</button>
        <button data-act="delete" data-name="${esc(bot.name)}" class="danger">Delete</button>
      </td></tr>`;
  }).join('');
  const totalMB = mem.totalMB || 8192;
  const freeMB = Math.max(0, mem.availableMB - usedMB);
  const pct = Math.min(100, Math.round((usedMB / totalMB) * 100));
  const full = freeMB < RESERVE_MB;
  const body = `
<section class="card">
  <h2>Capacity</h2>
  <p><strong>${bots.length}</strong> bot(s) · <strong>${usedMB} MB</strong> used by bots · host total <strong>${totalMB} MB</strong> · free <strong>${freeMB} MB</strong></p>
  <div class="meter"><div class="fill" style="width:${pct}%"></div></div>
  ${full
    ? '<p class="error">⚠️ Host is nearly full — new deploys are blocked until a bot is stopped or deleted.</p>'
    : '<p class="muted">A new bot needs about 270 MB free. Deploys are refused when less than 300 MB would remain.</p>'}
</section>
<section class="card">
  <h2>Your bots</h2>
  ${bots.length === 0
    ? '<p class="muted">No bots yet. <a href="/deploy">Deploy your first bot</a>.</p>'
    : `<div class="tablewrap"><table>
      <tr><th>Bot</th><th>Status</th><th>Uptime</th><th>RAM</th><th>Actions</th></tr>${rows}
      </table></div>`}
  <p id="msg" class="muted"></p>
  <pre id="logview" class="logview" style="display:none"></pre>
</section>
<script>
async function call(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(t.error || ('Request failed: ' + r.status));
  return t;
}
const msg = document.getElementById('msg');
document.querySelectorAll('button[data-act]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const name = btn.dataset.name, act = btn.dataset.act;
    try {
      if (act === 'logs') {
        const t = await call('/api/bots/' + encodeURIComponent(name) + '/logs');
        const el = document.getElementById('logview');
        el.style.display = 'block';
        el.textContent = '--- last 200 lines of ' + name + '/bot.log ---\\n' + (t.logs || '(empty)');
        el.scrollTop = el.scrollHeight;
        return;
      }
      if (act === 'delete' && !confirm('Delete bot "' + name + '" and all its files?')) return;
      msg.textContent = act + ' ' + name + '…';
      await call('/api/bots/' + encodeURIComponent(name) + '/' + act, { method: 'POST' });
      location.reload();
    } catch (e) { msg.textContent = 'Error: ' + e.message; }
  });
});
</script>`;
  res.send(layout('Dashboard', body));
});

app.get('/deploy', requireAuth, (req, res) => {
  const mem = readMeminfo();
  const usedMB = bots.reduce((sum, b) => sum + liveStatus(b).ramMB, 0);
  const freeMB = Math.max(0, mem.availableMB - usedMB);
  const body = `
<section class="card">
  <h2>Deploy a new Levanter bot</h2>
  <p class="muted">This clones the Levanter repo, runs <code>npm install</code>, writes <code>config.env</code> and starts the bot. Free RAM right now: <strong>${freeMB} MB</strong> (a bot needs ~270 MB).</p>
  <form id="deployForm">
    <label>Bot name <span class="muted">(lowercase letters, numbers and dashes only)</span><br>
      <input name="name" required pattern="[a-z0-9-]+" maxlength="40" placeholder="my-bot"></label>
    <label>WhatsApp session ID <span class="muted">(never shown again after saving)</span><br>
      <input type="password" name="sessionId" required placeholder="paste the Levanter session ID"></label>
    <label>SUDO numbers <span class="muted">(comma-separated, e.g. 923001234567,923007654321)</span><br>
      <input name="sudo" required placeholder="923001234567"></label>
    <label>Command prefix<br><input name="prefix" value="/" maxlength="3"></label>
    <label>Owner number <span class="muted">(optional)</span><br>
      <input name="owner" placeholder="923001234567"></label>
    <button type="submit">Deploy bot</button>
  </form>
  <div id="progress" style="display:none">
    <h3>Deploy progress</h3>
    <p id="pstep" class="muted">Starting…</p>
    <pre id="plog" class="logview"></pre>
    <p><a href="/dashboard">Go to dashboard</a></p>
  </div>
</section>
<script>
const form = document.getElementById('deployForm');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const prog = document.getElementById('progress');
  const pstep = document.getElementById('pstep');
  const plog = document.getElementById('plog');
  prog.style.display = 'block';
  pstep.textContent = 'Sending…';
  try {
    const r = await fetch('/api/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error || ('Deploy failed: ' + r.status));
    const poll = setInterval(async () => {
      const s = await (await fetch('/api/deploy-progress/' + t.jobId)).json();
      pstep.textContent = s.step + ': ' + s.message;
      if (s.done) {
        clearInterval(poll);
        plog.textContent = (s.error ? 'FAILED: ' + s.error : 'Done. ' + s.message) + '\\nOpen the dashboard and check the bot logs.';
      }
    }, 2000);
  } catch (e) { pstep.textContent = 'Error: ' + e.message; }
});
</script>`;
  res.send(layout('Deploy bot', body));
});

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------
app.get('/api/capacity', requireAuth, (req, res) => {
  const mem = readMeminfo();
  let usedMB = 0;
  const list = bots.map((b) => {
    const live = refreshBot(b);
    usedMB += live.ramMB;
    return { name: b.name, status: live.status, ramMB: live.ramMB, pid: live.pid, startedAt: b.startedAt };
  });
  res.json({
    hostTotalMB: mem.totalMB, hostAvailableMB: mem.availableMB,
    botsUsedMB: usedMB, freeMB: Math.max(0, mem.availableMB - usedMB),
    botCount: bots.length, canDeploy: Math.max(0, mem.availableMB - usedMB) >= RESERVE_MB + BOT_RAM_MB,
    bots: list,
  });
});

app.get('/api/bots', requireAuth, (req, res) => {
  res.json(bots.map((b) => {
    const live = refreshBot(b);
    return { name: b.name, status: live.status, ramMB: live.ramMB, pid: live.pid, startedAt: b.startedAt, createdAt: b.createdAt, sudo: b.sudo, prefix: b.prefix, owner: b.owner };
  }));
});

app.post('/api/deploy', requireAuth, (req, res) => {
  const { name, sessionId, sudo, prefix, owner } = req.body || {};
  // ---- validation ----
  if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) {
    return res.status(400).json({ error: 'Bot name must be 1-40 lowercase letters, numbers or dashes.' });
  }
  if (findBot(name)) return res.status(400).json({ error: `A bot named "${name}" already exists.` });
  if (!sessionId || String(sessionId).trim().length < 10) {
    return res.status(400).json({ error: 'A session ID is required (paste the full Levanter session ID).' });
  }
  if (!sudo || !/^[0-9,\s]+$/.test(String(sudo))) {
    return res.status(400).json({ error: 'SUDO must be one or more phone numbers, comma-separated.' });
  }
  const cleanPrefix = (prefix == null || prefix === '') ? '/' : String(prefix).slice(0, 3);
  const cleanOwner = (owner || '').replace(/[^0-9]/g, '');
  // ---- capacity check ----
  const mem = readMeminfo();
  const usedMB = bots.reduce((sum, b) => sum + liveStatus(b).ramMB, 0);
  const freeMB = Math.max(0, mem.availableMB - usedMB);
  if (freeMB < RESERVE_MB + BOT_RAM_MB) {
    return res.status(400).json({ error: `Not enough free RAM (${freeMB} MB free). Stop or delete a bot first.` });
  }
  const jobId = 'job-' + (++jobCounter) + '-' + Date.now().toString(36);
  const job = { name, step: 'queued', message: 'Deploy queued…', done: false, error: null };
  deployJobs.set(jobId, job);
  runDeploy(job, {
    name, sessionId: String(sessionId).trim(),
    sudo: String(sudo).replace(/\s+/g, ''), prefix: cleanPrefix, owner: cleanOwner,
  });
  res.json({ jobId });
});

app.get('/api/deploy-progress/:jobId', requireAuth, (req, res) => {
  const job = deployJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown deploy job.' });
  res.json(job);
});

app.get('/api/bots/:name/logs', requireAuth, (req, res) => {
  const bot = findBot(req.params.name);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  let logs = readLastLines(botLogFile(bot.name), 200);
  // Never leak the session ID through the log viewer.
  if (bot.sessionId) logs = logs.split(bot.sessionId).join('[SESSION_ID REDACTED]');
  res.json({ logs });
});

app.post('/api/bots/:name/start', requireAuth, async (req, res) => {
  const bot = findBot(req.params.name);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (liveStatus(bot).status === 'running') return res.json({ ok: true, status: 'running' });
  try {
    startBot(bot);
    res.json({ ok: true, status: 'running', pid: bot.pid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bots/:name/stop', requireAuth, async (req, res) => {
  const bot = findBot(req.params.name);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  await stopBot(bot);
  res.json({ ok: true, status: 'stopped' });
});

app.post('/api/bots/:name/restart', requireAuth, async (req, res) => {
  const bot = findBot(req.params.name);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  await stopBot(bot);
  try {
    startBot(bot);
    res.json({ ok: true, status: 'running', pid: bot.pid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bots/:name/delete', requireAuth, async (req, res) => {
  const bot = findBot(req.params.name);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  await stopBot(bot);
  try { fs.rmSync(botDir(bot.name), { recursive: true, force: true }); } catch (e) {}
  bots = bots.filter((b) => b.name !== bot.name);
  saveBots();
  res.json({ ok: true, deleted: bot.name });
});

// ---------------------------------------------------------------------------
// Startup: mark bots whose processes are gone as stopped (panel restarted).
// ---------------------------------------------------------------------------
for (const bot of bots) {
  if (bot.status === 'running' && !(bot.pid && pidAlive(bot.pid))) {
    bot.status = 'stopped'; bot.pid = null; bot.startedAt = null;
  }
}
saveBots();

app.listen(PORT, () => {
  console.log(`[panel] Levanter Hosting Panel v1 listening on http://localhost:${PORT}`);
  console.log(`[panel] Bots directory: ${BOTS_DIR}`);
});
