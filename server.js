#!/usr/bin/env node
/*
 * 歌唱比賽評分系統 — 區網即時同步伺服器
 * 不需要安裝任何套件，只要有 Node.js（v16 以上）即可執行：
 *     node server.js
 * 可選環境變數：
 *     PORT=3000          伺服器埠號
 *     ADMIN_PIN=1234     管理員 PIN（設定後，修改比賽設定需輸入 PIN）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = +process.env.PORT || 3000;
const PIN = process.env.ADMIN_PIN || '';
const DIR = __dirname;
const DATA = path.join(DIR, 'data.json');
const BACKUP_DIR = path.join(DIR, 'backups');
const ASSET_DIR = path.join(DIR, 'assets');

// ---------- 狀態與存檔 ----------
let state = {};
try { state = JSON.parse(fs.readFileSync(DATA, 'utf8')); console.log('已載入既有資料 data.json'); } catch (e) { state = {}; }

let saveTimer = null, dirtySinceBackup = false;
function save() {
  dirtySinceBackup = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state, null, 1), err => {
      if (err) return console.error('存檔失敗', err);
      fs.rename(tmp, DATA, e => e && console.error('存檔失敗', e));
    });
  }, 150);
}
// 每 3 分鐘自動備份一次（有變動才備份）
setInterval(() => {
  if (!dirtySinceBackup) return;
  dirtySinceBackup = false;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const t = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `data-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(state));
  } catch (e) { console.error('備份失敗', e); }
}, 3 * 60 * 1000);

// ---------- 操作套用 ----------
const BAD = new Set(['__proto__', 'prototype', 'constructor']);
function validPath(p) {
  return Array.isArray(p) && p.length > 0 && p.every(k => typeof k === 'string' && k.length < 200 && !BAD.has(k));
}
function applyOp(op) {
  if (op.op === 'replace' && Array.isArray(op.path) && op.path.length === 0) {
    state = (op.value && typeof op.value === 'object') ? op.value : {};
    return;
  }
  if (!validPath(op.path)) throw new Error('bad path');
  let o = state;
  const p = op.path;
  for (let i = 0; i < p.length - 1; i++) {
    if (o[p[i]] == null || typeof o[p[i]] !== 'object') o[p[i]] = {};
    o = o[p[i]];
  }
  const k = p[p.length - 1];
  if (op.op === 'del') delete o[k];
  else if (op.op === 'set') o[k] = op.value;
  else throw new Error('bad op');
}
const isScorePath = p => Array.isArray(p) && p.length === 3 && p[0] === 'scores';

// ---------- 即時推播（Server-Sent Events） ----------
const clients = new Map();
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcastState() {
  const msg = { state, meta: { requirePin: !!PIN } };
  for (const c of clients.values()) sse(c.res, 'state', msg);
}
function broadcastPresence() {
  const list = [...clients.values()].map(c => c.info);
  for (const c of clients.values()) sse(c.res, 'presence', list);
}
setInterval(() => { for (const c of clients.values()) c.res.write(': ping\n\n'); }, 15000);

// ---------- HTTP ----------
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', ch => { size += ch.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    fs.readFile(path.join(DIR, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('找不到 index.html，請與 server.js 放在同一個資料夾'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    const id = Math.random().toString(36).slice(2);
    const q = u.searchParams;
    const info = {
      device: q.get('device') || id, label: (q.get('label') || '').slice(0, 60),
      role: q.get('role') || '', seat: q.get('seat') || '',
      ip: (req.socket.remoteAddress || '').replace('::ffff:', ''), since: Date.now()
    };
    clients.set(id, { res, info });
    sse(res, 'state', { state, meta: { requirePin: !!PIN } });
    broadcastPresence();
    req.on('close', () => { clients.delete(id); broadcastPresence(); });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/state') return json(res, 200, state);

  // 大螢幕素材（海報、背景、Logo）
  if (req.method === 'GET' && u.pathname.startsWith('/api/asset/')) {
    const id = u.pathname.slice('/api/asset/'.length);
    if (!/^[a-z0-9]{4,24}$/.test(id)) { res.writeHead(404); return res.end(); }
    fs.readFile(path.join(ASSET_DIR, id + '.txt'), 'utf8', (err, txt) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=86400' });
      res.end(txt);
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/asset') {
    let body;
    try { body = JSON.parse(await readBody(req, 15 * 1024 * 1024)); } catch (e) { return json(res, 400, { error: 'bad body' }); }
    if (PIN && body.pin !== PIN) return json(res, 403, { error: 'pin' });
    if (!/^[a-z0-9]{4,24}$/.test(body.id || '')) return json(res, 400, { error: 'bad id' });
    const file = path.join(ASSET_DIR, body.id + '.txt');
    if (body.delete) { fs.unlink(file, () => {}); return json(res, 200, { ok: true }); }
    if (typeof body.data !== 'string' || !body.data.startsWith('data:image/')) return json(res, 400, { error: 'not image' });
    try { fs.mkdirSync(ASSET_DIR, { recursive: true }); fs.writeFileSync(file, body.data); }
    catch (e) { return json(res, 500, { error: 'write failed' }); }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && u.pathname === '/api/ops') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const ops = Array.isArray(body.ops) ? body.ops : [];
    const pinOk = !PIN || body.pin === PIN;
    if (ops.length === 0) return pinOk ? json(res, 200, { ok: true }) : json(res, 403, { error: 'pin' });
    for (const op of ops) {
      if (isScorePath(op.path)) {
        const st = state.status && state.status[op.path[1]];
        if (st !== 'open' && !pinOk) return json(res, 409, { error: 'not open' });
        if (st === 'locked') return json(res, 409, { error: 'locked' });
      } else if (!pinOk) {
        return json(res, 403, { error: 'pin' });
      }
    }
    const backup = JSON.stringify(state);
    try { ops.forEach(applyOp); }
    catch (e) { state = JSON.parse(backup); return json(res, 400, { error: e.message }); }
    save();
    broadcastState();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎤 歌唱比賽評分系統已啟動');
  console.log(`   本機：http://localhost:${PORT}`);
  for (const arr of Object.values(os.networkInterfaces())) {
    for (const a of arr || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) console.log(`   其他電腦請開：http://${a.address}:${PORT}`);
    }
  }
  console.log(PIN ? '   管理員 PIN：已啟用' : '   管理員 PIN：未啟用（可用 ADMIN_PIN=1234 node server.js 啟用）');
  console.log('   資料自動儲存於 data.json，並定期備份到 backups/ 資料夾');
  console.log('   關閉伺服器：按 Ctrl + C\n');
});
