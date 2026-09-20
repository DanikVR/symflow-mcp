/**
 * SymFlow — the bridge between Claude (MCP) and the SymFlow Chrome extension.
 *
 * Why a bridge: an MCP server cannot reach into a browser extension and an extension cannot be
 * a server. This tiny HTTP process is where one side PUTS tasks (POST /jobs) and the other side
 * TAKES them by polling (GET /next) and REPORTS the outcome (POST /result).
 *
 * State lives in memory: the queue is ephemeral by design. Only finished files (OUT_DIR),
 * per-job manifest.json files and the dev capture log touch the disk.
 *
 * Addressing: 127.0.0.1 by default (Claude and the browser on one machine). For Claude on
 * another device bind to a Tailscale address with OF_HOST=100.x.y.z; a non-loopback bind
 * requires the token from ~/.symflow-token (header X-SymFlow-Token or ?token=).
 *
 * Security: requests with an http(s) Origin are refused — any open web page can POST to a
 * local port, so browser callers are accepted only from chrome-extension://. Requests without
 * an Origin (curl, MCP) are ours.
 *
 * What is NOT here: the Symphony adapter, the director playbook and the pricing rules. They
 * live in the extension; the playbook reaches the bridge at runtime (POST /brief).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_PORT = Number(process.env.OF_PORT || 8789);
export const HOST = process.env.OF_HOST || '127.0.0.1';
let OUT_DIR = path.resolve(process.env.OF_OUT || path.join(process.cwd(), 'symflow-out'));
function ensureOutDir() {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); return; }
  catch (e) {
    if (process.env.OF_OUT) throw e;
    const fallback = path.join(os.homedir(), 'symflow-out');
    log(`cannot create ${OUT_DIR} (${e.code}) — using ${fallback}`);
    OUT_DIR = fallback;
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
}
const TOKEN_FILE = path.join(os.homedir(), '.symflow-token');
const MAX_BODY = 64 * 1024 * 1024;
const RESUME_MS = 90_000;              // running task silent longer than this → hand it back for resume
const EXT_STALE_MS = 25_000;
const INBOX_MAX = 20;
const CAPTURE_MAX = 400;

const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
export function loadToken() {
  try {
    if (process.env.OF_TOKEN) return process.env.OF_TOKEN.trim();
    if (fs.existsSync(TOKEN_FILE)) { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; }
  } catch { /* create below */ }
  const t = randomBytes(24).toString('base64url');
  try { fs.writeFileSync(TOKEN_FILE, t + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* lives until restart */ }
  return t;
}
export const TOKEN = loadToken();
function tokenOk(given) {
  if (isLoopback(HOST)) return true;
  const a = Buffer.from(String(given || '')); const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const jobs = new Map();     // jobId → {id, createdAt, items:[taskId], dir, opts}
const tasks = new Map();    // taskId → task
const blobs = new Map();    // blobId → {path, mime, name}
const inbox = [];           // templates sent with the "→ Claude" button (newest last)
const captureLog = [];      // dev: bodies captured by the extension
let devReload = 0;
let captureMode = false;
const extLog = [];
let ext = { seenAt: 0, tabReady: false, signedIn: false, url: '', version: '', license: 'unknown', idle: '', pausedUntil: 0, credits: null, creditsBlock: null };
let brief = { text: '', digest: '', version: '' };
const BRIEF_MAX = 40_000;
const now = () => Date.now();
const log = (...a) => console.error('[symflow]', ...a);   // stderr: stdout is the MCP transport

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
const SMALL = 6 * 1024 * 1024;   // up to this size the file travels inline as a dataURL; bigger → /blob/<id>

/** A file reference from Claude (absolute path) → what the extension needs (dataUrl or blobId). */
function fileSpec(p, kind, extra) {
  const abs = path.resolve(String(p));
  const st = fs.statSync(abs);
  const mime = mimeOf(abs);
  // the file type wins over the list it came in: an .mp4 among "images" is still a video reference
  const k = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : (kind || 'image');
  const spec = { name: path.basename(abs), mime, size: st.size, kind: k, path: abs, ...(extra || {}) };
  if (st.size <= SMALL) spec.dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  else { const id = 'b_' + randomUUID().slice(0, 12); blobs.set(id, { path: abs, mime, name: spec.name }); spec.blobId = id; }
  return spec;
}
const listFiles = (arr, kind) => (Array.isArray(arr) ? arr : []).map((x) => {
  if (typeof x === 'string') return /^https?:\/\//.test(x) ? { url: x, kind } : fileSpec(x, kind);
  if (x && x.url) return { url: x.url, kind: x.kind || kind, name: x.name || '' };
  if (x && x.vid) return { vid: x.vid, kind: 'video', name: x.name || '' };
  return fileSpec(x.path, x.kind || kind, { role: x.role, label: x.label });
});

/** Normalise one job item. `tool` selects the adapter routine; params are passed through. */
function normalizeItem(raw, opts) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const tool = String(it.tool || opts.tool || 'generate');
  const params = { ...(it.params || {}) };
  const task = { id: randomUUID(), status: 'queued', createdAt: now(), updatedAt: now(), tool, params, dryRun: !!(it.dryRun || opts.dryRun), noWait: !!it.noWait, files: [], error: null, data: null, taskIds: [] };
  // paths → transferable specs (bridge reads the disk, the extension never does)
  if (params.images) params.images = listFiles(params.images, 'image');
  if (params.videos) params.videos = listFiles(params.videos, 'video');
  if (params.audios) params.audios = listFiles(params.audios, 'audio');
  if (params.files) params.files = listFiles(params.files);
  if (params.frame) { params.images = [...listFiles([params.frame], 'image'), ...(params.images || [])]; delete params.frame; }
  task.label = String(params.prompt || params.script || params.productName || tool).slice(0, 80);
  return task;
}
function claimable(limit) {
  const out = [];
  for (const t of tasks.values()) {
    if (out.length >= limit) break;
    const stale = t.status === 'running' && now() - t.updatedAt > RESUME_MS && t.taskIds.length > 0;
    if (stale) { t.resumeCount = (t.resumeCount || 0) + 1; if (t.resumeCount > 3) { t.status = 'failed'; t.error = 'resume failed 3 times'; t.finishedAt = now(); continue; } t.resume = { taskIds: t.taskIds, n: t.resumeCount }; }
    if (t.status === 'queued' || stale) out.push(t);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
}
/** Files downloaded by the extension (Chrome downloads folder) → moved into the job folder. */
function collectFiles(task, data) {
  const job = jobs.get(task.jobId);
  const dir = job ? job.dir : OUT_DIR;
  const files = [];
  let n = 0;
  for (const r of (data && data.results) || []) {
    for (const f of r.files || []) {
      n++;
      if (f.file && fs.existsSync(f.file)) { files.push({ ...f }); continue; }   // already written by POST /file
      if (f.localPath && fs.existsSync(f.localPath)) {
        const target = path.join(dir, resultName(task, n, path.extname(f.localPath) || '.mp4'));
        try { fs.renameSync(f.localPath, target); } catch { try { fs.copyFileSync(f.localPath, target); fs.unlinkSync(f.localPath); } catch (e) { log('move failed: ' + e.message); files.push({ ...f, file: f.localPath }); continue; } }
        files.push({ ...f, file: target, localPath: undefined });
      } else files.push({ ...f });
    }
  }
  return files;
}
function jobView(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  const items = j.items.map((id) => { const t = tasks.get(id); return t ? { id: t.id, seq: t.seq, tool: t.tool, status: t.status, label: t.label, taskIds: t.taskIds, files: t.files.map((f) => f.file || f.links && (f.links.original || f.links.watermarked) || null).filter(Boolean), data: t.data, error: t.error, code: t.code || null, extra: t.extra || null, timedOut: !!t.timedOut } : null; }).filter(Boolean);
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  return { jobId, dir: j.dir, total: items.length, done, failed, finished: done + failed >= items.length, items };
}
function currentWork() {
  const run = [...tasks.values()].filter((t) => t.status === 'running');
  const queued = [...tasks.values()].filter((t) => t.status === 'queued');
  if (!run.length && !queued.length) return { state: 'idle' };
  return { state: run.length ? 'running' : 'queued', running: run.map((t) => ({ id: t.id, tool: t.tool, label: t.label, sec: t.startedAt ? Math.round((now() - t.startedAt) / 1000) : null, taskIds: t.taskIds })), queued: queued.length };
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('file too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Name of a result file inside the job folder: prefix, sequence, label, variant number, extension. */
function resultName(task, n, ext) {
  const safe = String(task.label || task.tool).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 48) || task.tool;
  return `${task.prefix ? task.prefix + ' ' : ''}${String(task.seq || 0).padStart(2, '0')} ${safe}${n > 1 ? ' (' + n + ')' : ''}${ext}`;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('invalid JSON: ' + e.message)); } });
    req.on('error', reject);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) return send(res, 403, { error: 'origin not allowed' });
    if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('access-control-allow-headers', 'content-type,x-symflow-token'); res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS'); }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (route !== '/ping' && !tokenOk(req.headers['x-symflow-token'] || url.searchParams.get('token'))) return send(res, 401, { error: 'SymFlow token required (~/.symflow-token)' });
    try {
      if (req.method === 'GET' && route === '/ping') return send(res, 200, { ok: true, service: 'symflow', needsToken: !isLoopback(HOST), devReload });
      if (req.method === 'GET' && route === '/health') {
        const alive = now() - ext.seenAt < EXT_STALE_MS;
        return send(res, 200, {
          ok: true, outDir: OUT_DIR,
          extension: { connected: alive, tabReady: alive && ext.tabReady, signedIn: alive && ext.signedIn, url: ext.url, version: ext.version, license: ext.license,
            director: alive ? brief.text : '', directorDigest: alive ? brief.digest : '', lastSeenSecAgo: ext.seenAt ? Math.round((now() - ext.seenAt) / 1000) : null,
            idle: ext.idle || '', pausedForSec: ext.pausedUntil > now() ? Math.round((ext.pausedUntil - now()) / 1000) : 0,
            credits: ext.credits, creditsBlock: ext.creditsBlock },
          queue: { queued: [...tasks.values()].filter((t) => t.status === 'queued').length, running: [...tasks.values()].filter((t) => t.status === 'running').length, jobs: jobs.size },
          inbox: inbox.slice(-5).map((x) => ({ at: x.at, template: x.template && { templateId: x.template.templateId, name: x.template.name, description: x.template.description, duration: x.template.duration } })),
          now: currentWork(),
        });
      }
      if (req.method === 'POST' && route === '/hello') {
        const b = await readBody(req);
        ext = { seenAt: now(), tabReady: !!b.tabReady, signedIn: !!b.signedIn, url: String(b.url || '').slice(0, 200), version: String(b.version || ''), license: String(b.license || 'unknown').slice(0, 20), idle: String(b.idle || '').slice(0, 20), pausedUntil: Number(b.pausedUntil) || 0, credits: b.credits || null, creditsBlock: b.creditsBlock || null };
        if (b.idle === 'busy') for (const x of tasks.values()) if (x.status === 'running') x.updatedAt = now();
        const needBrief = !brief.text || brief.version !== ext.version;
        return send(res, 200, { ok: true, devReload, needBrief, capture: captureMode });
      }
      if (req.method === 'POST' && route === '/brief') { const b = await readBody(req); brief = { text: String(b.brief || '').slice(0, BRIEF_MAX), digest: String(b.digest || '').slice(0, 32), version: String(b.version || '').slice(0, 20) }; return send(res, 200, { ok: true, chars: brief.text.length }); }
      if (req.method === 'POST' && route === '/log') { const b = await readBody(req); for (const l of (Array.isArray(b.lines) ? b.lines : [])) extLog.push({ t: Number(l.t) || now(), src: String(l.src || ''), text: String(l.text || '').slice(0, 400) }); if (extLog.length > 400) extLog.splice(0, extLog.length - 400); return send(res, 200, { ok: true }); }
      if (req.method === 'GET' && route === '/log') { const n = Math.max(1, Math.min(400, Number(url.searchParams.get('n')) || 60)); return send(res, 200, { ok: true, lines: extLog.slice(-n) }); }
      // ── "→ Claude" button: templates sent from the studio page ──
      if (req.method === 'POST' && route === '/inbox') { const b = await readBody(req); inbox.push({ at: now(), template: b.template || null, url: String(b.url || '').slice(0, 200) }); if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX); log('inbox: ' + ((b.template && b.template.name) || '?')); return send(res, 200, { ok: true, count: inbox.length }); }
      if (req.method === 'GET' && route === '/inbox') { const items = inbox.slice().reverse(); if (url.searchParams.get('clear') === '1') inbox.length = 0; return send(res, 200, { ok: true, items }); }
      // ── dev: request capture ──
      if (req.method === 'POST' && route === '/capture') {
        const b = await readBody(req);
        captureLog.push({ t: now(), ...b });
        if (captureLog.length > CAPTURE_MAX) captureLog.splice(0, captureLog.length - CAPTURE_MAX);
        try { const dir = path.join(OUT_DIR, '_capture'); fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'capture-' + new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify({ t: now(), ...b }) + '\n'); } catch { /* */ }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/dev/capture') { const b = await readBody(req); captureMode = !!b.on; return send(res, 200, { ok: true, capture: captureMode }); }
      if (req.method === 'GET' && route === '/capture') { const n = Math.max(1, Math.min(400, Number(url.searchParams.get('n')) || 50)); return send(res, 200, { ok: true, items: captureLog.slice(-n) }); }
      if (req.method === 'POST' && route === '/dev/reload') { devReload = now(); return send(res, 200, { ok: true, devReload }); }
      // ── bytes of a big task file for the extension ──
      if (req.method === 'GET' && /^\/blob\/[^/]+$/.test(route)) {
        const b = blobs.get(route.split('/')[2]);
        if (!b || !fs.existsSync(b.path)) return send(res, 404, { error: 'no such blob' });
        const st = fs.statSync(b.path);
        res.writeHead(200, { 'content-type': b.mime, 'content-length': st.size, 'x-file-name': encodeURIComponent(b.name) });
        return fs.createReadStream(b.path).pipe(res);
      }
      // ── jobs ──
      if (req.method === 'POST' && route === '/jobs') {
        const b = await readBody(req);
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) return send(res, 400, { error: 'items is empty' });
        if (items.length > 40) return send(res, 400, { error: 'no more than 40 items per job' });
        const opts = b.opts && typeof b.opts === 'object' ? b.opts : {};
        const jobId = 'job_' + randomUUID().slice(0, 8);
        const dir = path.join(OUT_DIR, (opts.folder ? String(opts.folder).replace(/[^\p{L}\p{N} _-]+/gu, '') + ' ' : '') + jobId);
        fs.mkdirSync(dir, { recursive: true });
        const ids = []; let seq = 0;
        for (const raw of items) { const t = normalizeItem(raw, opts); t.seq = ++seq; t.jobId = jobId; t.prefix = opts.prefix ? String(opts.prefix) : ''; tasks.set(t.id, t); ids.push(t.id); }
        jobs.set(jobId, { id: jobId, createdAt: now(), items: ids, dir, opts });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ jobId, createdAt: new Date().toISOString(), opts, items: ids.map((id) => { const t = tasks.get(id); const p = { ...t.params }; for (const k of ['images', 'videos', 'audios', 'files']) if (p[k]) p[k] = p[k].map((f) => f.path || f.url || f.vid || f.name); return { seq: t.seq, tool: t.tool, dryRun: t.dryRun, params: p }; }) }, null, 2), 'utf8');
        log(`job ${jobId}: ${ids.length} item(s) → ${dir}`);
        return send(res, 200, { ok: true, jobId, count: ids.length, dir });
      }
      if (req.method === 'GET' && route === '/next') {
        ext.seenAt = now();
        const limit = Math.max(1, Math.min(4, Number(url.searchParams.get('limit') || 1)));
        const picked = claimable(limit);
        for (const t of picked) { t.status = 'running'; t.updatedAt = now(); t.startedAt = t.startedAt || now(); }
        return send(res, 200, { tasks: picked.map((t) => ({ id: t.id, tool: t.tool, params: t.params, dryRun: t.dryRun, noWait: t.noWait, resume: t.resume || null })) });
      }
      // ── bytes of a finished file, fetched inside the studio tab (the CDN wants its Referer) ──
      if (req.method === 'POST' && route === '/file') {
        const t = tasks.get(String(url.searchParams.get('id') || ''));
        if (!t) return send(res, 404, { error: 'no such task' });
        const buf = await readRaw(req, 512 * 1024 * 1024);
        const job = jobs.get(t.jobId);
        const dir = job ? job.dir : OUT_DIR;
        const ext = String(url.searchParams.get('ext') || '.mp4').replace(/[^.a-z0-9]/gi, '') || '.mp4';
        const n = Number(url.searchParams.get('n') || 1);
        const label = String(url.searchParams.get('label') || '');
        if (label && (t.tool === 'wait' || !t.label || t.label === t.tool)) t.label = label.slice(0, 80);
        let file = path.join(dir, resultName(t, n, ext));
        for (let k = 2; fs.existsSync(file); k++) file = path.join(dir, resultName(t, n, ext).replace(/(\.[a-z0-9]+)$/i, ` ${k}$1`));
        fs.writeFileSync(file, buf);
        t.updatedAt = now();
        log(`file ${path.basename(file)} ${buf.length} bytes`);
        return send(res, 200, { ok: true, file, bytes: buf.length });
      }
      if (req.method === 'POST' && route === '/progress') { const b = await readBody(req); const t = tasks.get(String(b.id || '')); if (!t) return send(res, 404, { error: 'no such task' }); t.updatedAt = now(); if (Array.isArray(b.taskIds)) t.taskIds = b.taskIds.map(String); if (b.submitted) t.submitted = b.submitted; return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && route === '/result') {
        const b = await readBody(req);
        const t = tasks.get(String(b.id || ''));
        if (!t) return send(res, 404, { error: 'no such task' });
        t.updatedAt = now(); t.finishedAt = now();
        if (b.ok) {
          // after a service-worker restart the extension resumes by taskId and no longer knows the
          // submit data (cost, model): merge what it reported at submit time
          t.data = { ...(t.submitted || {}), ...(b.data || {}) };
          t.files = collectFiles(t, b.data);
          const results = (b.data && b.data.results) || [];
          const anyFail = results.some((r) => r.ok === false) || t.files.some((f) => f.status === 'failed');
          t.timedOut = results.some((r) => r.timedOut);
          t.status = anyFail && !t.files.some((f) => f.file) ? 'failed' : 'done';
          if (t.status === 'failed') t.error = (results.find((r) => r.ok === false) || {}).error || (t.files.find((f) => f.error) || {}).error || 'the studio reported a failure';
          log(`${t.status === 'done' ? '✓' : '✕'} ${t.seq} ${t.tool}: ${t.files.map((f) => path.basename(f.file || '')).filter(Boolean).join(', ') || (t.data && t.data.dryRun ? 'dry run' : t.error || 'no files')}`);
        } else { t.status = 'failed'; t.error = String(b.error || 'no reason').slice(0, 400); t.code = b.code || null; t.extra = b.extra || null; log(`✕ ${t.seq} ${t.tool}: ${t.error}`); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && /^\/jobs\/[^/]+$/.test(route)) { const v = jobView(route.split('/')[2]); return v ? send(res, 200, v) : send(res, 404, { error: 'no such job' }); }
      if (req.method === 'GET' && route === '/jobs') return send(res, 200, { jobs: [...jobs.keys()].map(jobView) });
      if (req.method === 'POST' && route === '/cancel') { let n = 0; for (const t of tasks.values()) if (t.status === 'queued') { t.status = 'failed'; t.error = 'cancelled'; n++; } return send(res, 200, { ok: true, cancelled: n }); }
      return send(res, 404, { error: 'no such route' });
    } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
  });
}
export function startBridge(port = DEFAULT_PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    ensureOutDir();
    const srv = createServer();
    srv.once('error', (e) => (e && e.code === 'EADDRINUSE' ? resolve({ port, host, already: true, close: () => {} }) : reject(e)));
    srv.listen(port, host, () => {
      log(`listening on http://${host}:${port} · results → ${OUT_DIR}`);
      if (isLoopback(host)) log('bound to loopback — no token required'); else log(`EXTERNAL bind — the extension needs this token: ${TOKEN}`);
      resolve({ port, host, already: false, close: () => srv.close() });
    });
  });
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('bridge/server.mjs')) startBridge().catch((e) => { log('failed to start:', e.message); process.exit(1); });
