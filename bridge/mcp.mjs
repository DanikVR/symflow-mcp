#!/usr/bin/env node
/**
 * SymFlow MCP — MCP server (stdio, JSON-RPC 2.0) on top of the local bridge.
 *
 * Claude launches this file as an MCP server; it starts the bridge itself (unless one is already
 * running) and exposes the sym_* tools. JSON-RPC is implemented by hand: zero dependencies.
 *
 * IMPORTANT: stdout is the protocol transport. Diagnostics go to stderr ONLY.
 *
 * The director playbook, the Symphony adapter and the pricing rules are NOT in this repository:
 * the SymFlow Chrome extension sends the playbook to the bridge at runtime (POST /brief) and
 * Claude receives it in sym_status as `extension.director`.
 */
import { startBridge, DEFAULT_PORT, HOST, TOKEN } from './server.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'symflow', version: '0.1.0' };
const BASE = `http://${HOST}:${DEFAULT_PORT}`;
const log = (...a) => console.error('[symflow-mcp]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init) => {
  const opts = { ...(init || {}) };
  opts.headers = { ...(opts.headers || {}), 'x-symflow-token': TOKEN };
  const r = await fetch(BASE + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const postJob = (items, opts) => api('/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items, opts: opts || {} }) });
async function waitJob(jobId, timeoutSec) {
  const deadline = Date.now() + Math.max(5, Math.min(3600, Number(timeoutSec || 600))) * 1000;
  let view = await api(`/jobs/${encodeURIComponent(jobId)}`);
  let delay = 1500;
  while (!view.finished && Date.now() < deadline) { await sleep(delay); delay = Math.min(5000, delay + 500); view = await api(`/jobs/${encodeURIComponent(jobId)}`); }
  return { ...view, timedOut: !view.finished };
}
/** Read-only call executed inside the studio tab: one-item job, wait for it, unwrap the data. */
async function quick(tool, params, timeoutSec) {
  const h = await api('/health');
  if (!h.extension || !h.extension.connected) throw new Error('SymFlow extension is not connected: install it from https://lingoflow.pro/symflow and open ads.tiktok.com/creative/creativestudio signed in');
  const j = await postJob([{ tool, params: params || {}, noWait: true }], { folder: '_quick' });
  const v = await waitJob(j.jobId, timeoutSec || 120);
  const it = v.items[0] || {};
  if (it.status === 'failed') { const e = new Error(it.error || 'failed'); e.code = it.code; e.extra = it.extra; throw e; }
  if (!v.finished) throw new Error('no answer from the studio tab in ' + (timeoutSec || 120) + ' s — is the extension connected and the tab signed in?');
  return it.data;
}
const err = (e) => `Error: ${(e && e.message) || e}` + (e && e.code ? ` [${e.code}]` : '') + (e && e.extra ? ` ${JSON.stringify(e.extra)}` : '');

const FILE = { type: 'string', description: 'Absolute path on disk (the bridge reads it) or an https URL already inside Symphony' };
const FILES = (d) => ({ type: 'array', description: d, items: FILE });

const TOOLS = [
  { name: 'sym_status', description: 'Bridge and extension state: whether the SymFlow extension is connected, whether a Creative Studio tab is open and signed in, credits (weekly grant, spent, next refill, available models), the queue, the last templates sent with the "→ Claude" button (inbox) — plus `extension.director`, the director playbook sent by the extension. Call it FIRST and follow the playbook. If extension.license is "expired", ask the user to activate a key (https://lingoflow.pro/symflow); the queue resumes by itself.',
    inputSchema: { type: 'object', properties: {} }, handler: () => api('/health') },
  { name: 'sym_inbox', description: 'Templates the user sent from the studio page with the "→ Claude" button (full director prompt, reference image, sample). Newest first. clear:true empties the inbox after reading.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean' } } }, handler: (a) => api('/inbox' + (a.clear ? '?clear=1' : '')) },
  { name: 'sym_credits', description: 'Live Symphony credit account: balance, weekly grant and spent, tier, available models, recent ledger with the price actually charged per task, expected next refill. Use before batches and after failures.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'ledger entries, default 10' } } }, handler: (a) => quick('credits', { limit: a.limit }) },
  { name: 'sym_templates', description: 'TikTok trend templates (about 78) with name, description, use cases, industry, reference image and the director prompt (videoPrompt, truncated unless full:true). useCase: 1 viral ads (default list), 8 ready-to-use on the Create page; query filters by text.',
    inputSchema: { type: 'object', properties: { useCase: { type: 'number' }, query: { type: 'string' }, industryId: { type: 'string' }, page: { type: 'number' }, limit: { type: 'number' }, full: { type: 'boolean', description: 'return the complete videoPrompt of every template' } } }, handler: (a) => quick('templates', a) },
  { name: 'sym_template', description: 'One template with its COMPLETE director prompt (Format & Look, Lenses, Grade, shot list), reference image URL and sample video. Use it as the structure of your own prompt.',
    inputSchema: { type: 'object', properties: { templateId: { type: 'string' }, inspirationItemId: { type: 'string' } }, required: ['templateId'] }, handler: (a) => quick('template_detail', a) },
  { name: 'sym_generate', description: 'Queue video/image generation in the live Symphony account. Modes: r2v (reference-to-video: up to 4 photos/videos on Seedance 1.5, 12 on 2.0, 50 on 2.5; optional templateId adds the template reference first), i2v (image-to-video from 1–2 frames), t2v (text-to-video), i2i (image with Nano Banana Pro / Flux). Returns jobId immediately; the extension waits for the render and downloads the files — get them with sym_wait. ALWAYS run with dryRun:true first unless the user confirmed the cost: dryRun returns model, seconds, cost in credits and balance without spending.',
    inputSchema: { type: 'object', properties: {
      items: { type: 'array', description: 'One entry per clip', items: { type: 'object', properties: {
        mode: { type: 'string', enum: ['r2v', 'i2v', 't2v', 'i2i'], description: 'default: r2v when images are given, otherwise t2v' },
        prompt: { type: 'string', description: 'Prompt in English: subject → action → camera → light → mood. Name the product exactly as in the photo' },
        images: FILES('Reference images/videos in order (paths or Symphony URLs). For i2v the first one is the frame'),
        templateId: { type: 'string', description: 'Trend template to build on (its reference image goes first)' },
        useTemplateReference: { type: 'boolean', description: 'default true' },
        model: { type: 'string', description: 'Seedance 1.5 | Seedance 2.0 | Seedance 2.0 Mini | Seedance 2.0 Fast | Seedance 2.5 | Nano Banana Pro | Flux Kontext Max — default: the best model the account has' },
        seconds: { type: 'number', description: '5 | 10 | 12 (Seedance 1.5/2.0) or 4–30 (Seedance 2.5)' },
        count: { type: 'number', description: 'variants 1–5 (each is a separate charge)' },
        watermarked: { type: 'boolean', description: 'also fetch the official watermarked export' },
        dryRun: { type: 'boolean' },
      }, required: ['prompt'] } },
      folder: { type: 'string', description: 'Results subfolder' }, prefix: { type: 'string' }, dryRun: { type: 'boolean', description: 'dry run for all items' },
    }, required: ['items'] },
    handler: (a) => postJob(a.items.map((it) => ({ tool: 'generate', params: it, dryRun: !!(it.dryRun || a.dryRun) })), { folder: a.folder, prefix: a.prefix }) },
  { name: 'sym_avatars', description: 'Avatars: kind aigc (1400+ AI-generated presenters, default), real (licensed real people), tryon (avatars for apparel/product try-on), product (avatars holding a product). Filter by query (name/tags) or tagsAll (e.g. ["female","e-comm","western_europe"]). Returns avatarId, name, tags, cover, preview.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['aigc', 'real', 'tryon', 'product'] }, query: { type: 'string' }, tagsAll: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, page: { type: 'number' } } }, handler: (a) => quick('avatars', a) },
  { name: 'sym_voices', description: 'Voices for talking avatars (assets of the studio) with tags (language, gender, age, style) and preview audio. language: e.g. english, spanish; gender: male|female.',
    inputSchema: { type: 'object', properties: { language: { type: 'string' }, gender: { type: 'string' }, query: { type: 'string' }, recommendOnly: { type: 'boolean' }, limit: { type: 'number' } } }, handler: (a) => quick('voices', a) },
  { name: 'sym_avatar_video', description: 'Talking avatar video from a script: the studio synthesises the voice (TTS), lip-syncs the avatar and adds captions. script ≤ 1000 characters in the spoken language; voiceId from sym_voices (default: the avatar\'s own voice); speed 0.8–1.3. Currently free of credits. Returns jobId — wait with sym_wait.',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { avatarId: { type: 'string' }, script: { type: 'string' }, voiceId: { type: 'string' }, speed: { type: 'string' }, captions: { type: 'boolean' }, volume: { type: 'number' }, name: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['avatarId', 'script'] } }, folder: { type: 'string' }, prefix: { type: 'string' } }, required: ['items'] },
    handler: (a) => postJob(a.items.map((it) => ({ tool: 'avatar_video', params: it, dryRun: !!it.dryRun })), { folder: a.folder, prefix: a.prefix }) },
  { name: 'sym_tryon', description: 'Avatar try-on: a video of an avatar wearing the user\'s apparel (kind apparel) or presenting the product (kind product). avatarId from sym_avatars kind=tryon|product; images = product/apparel photos. Returns jobId.',
    inputSchema: { type: 'object', properties: { avatarId: { type: 'string' }, images: FILES('photos of the apparel or product'), kind: { type: 'string', enum: ['apparel', 'product'] }, prompt: { type: 'string' }, folder: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['avatarId', 'images'] },
    handler: (a) => postJob([{ tool: 'tryon', params: a, dryRun: !!a.dryRun }], { folder: a.folder }) },
  { name: 'sym_transform', description: '"Video refresh": Symphony cuts new TikTok-ready clips (15 or 30 s) from the user\'s own product videos (each ≥ 15 s) and photos, with a voice-over in one of 11 languages (ar de en es fr id ms vi th ja pt). Returns jobId.',
    inputSchema: { type: 'object', properties: { videos: FILES('source videos ≥ 15 s'), images: FILES('product photos'), productName: { type: 'string' }, productDescription: { type: 'string' }, language: { type: 'string' }, seconds: { type: 'number', enum: [15, 30] }, folder: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['videos', 'productName'] },
    handler: (a) => postJob([{ tool: 'transform', params: a, dryRun: !!a.dryRun }], { folder: a.folder }) },
  { name: 'sym_dub', description: 'Dubbing: translate the speech of a video into other languages with a synthetic voice; options: replace burned-in subtitles, lip-sync (one visible speaker). Up to 20 videos per call. Returns jobId.',
    inputSchema: { type: 'object', properties: { videos: FILES('videos to dub'), targets: { type: 'array', items: { type: 'string' }, description: 'target languages as named by Symphony (English, Spanish, Japanese…)' }, source: { type: 'string', description: 'source language, default auto detect' }, voiceId: { type: 'string' }, replaceSubtitles: { type: 'boolean' }, lipsync: { type: 'boolean' }, folder: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['videos', 'targets'] },
    handler: (a) => postJob([{ tool: 'dub', params: a, dryRun: !!a.dryRun }], { folder: a.folder }) },
  { name: 'sym_editor', description: 'Server-side draft of the Symphony editor: op get (read the draft JSON), update (write a changed draft), estimate, render, check_render, export. Drafts are CapCut-style documents (tracks, materials, texts); change them structurally and render.',
    inputSchema: { type: 'object', properties: { op: { type: 'string', enum: ['get', 'update', 'estimate', 'render', 'check_render', 'export'] }, draftId: { type: 'string' }, draft: { type: 'object' }, renderParams: { type: 'object' }, exportParams: { type: 'object' }, taskId: { type: 'string' } }, required: ['op', 'draftId'] }, handler: (a) => quick('editor', a, 180) },
  { name: 'sym_history', description: 'What was generated in this account: drafts with status, type, vid, cover, errors. miniAppTypes: 1 refresh, 2 i2v, 3 t2v, 5 hpi, 6 try-on, 7 dubbing, 9 avatar, 11 image, 13 r2v.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' }, miniAppTypes: { type: 'array', items: { type: 'number' } } } }, handler: (a) => quick('history', a) },
  { name: 'sym_links', description: 'Download links of a finished draft: original file (no watermark) and, with watermarked:true, the official export. The extension downloads files by itself for jobs; use this for older drafts from sym_history.',
    inputSchema: { type: 'object', properties: { draftId: { type: 'string' }, watermarked: { type: 'boolean' } }, required: ['draftId'] }, handler: (a) => quick('links', a, 180) },
  { name: 'sym_upload', description: 'Upload files into the Symphony library without generating anything (to reuse URLs/vids across tasks).',
    inputSchema: { type: 'object', properties: { files: FILES('files to upload') }, required: ['files'] }, handler: (a) => quick('upload', { files: a.files }, 600) },
  { name: 'sym_download', description: 'Download the files of an already finished studio task (taskId from sym_history / sym_status) into a job folder without generating anything. Returns jobId — get the paths with sym_wait.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, watermarked: { type: 'boolean' }, folder: { type: 'string' } }, required: ['taskId'] },
    handler: (a) => postJob([{ tool: 'wait', params: { taskId: a.taskId, watermarked: !!a.watermarked, timeoutSec: 30 } }], { folder: a.folder || 'Downloads' }) },
  { name: 'sym_wait', description: 'Wait for a job and return its items with local file paths (symflow-out/<job>/…), links, cost data and errors. Returns the intermediate picture on timeout — call again.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, timeoutSec: { type: 'number', description: 'default 600; a Seedance clip takes 1–6 min, dubbing/refresh up to 15' } }, required: ['jobId'] }, handler: (a) => waitJob(a.jobId, a.timeoutSec) },
  { name: 'sym_cancel', description: 'Remove everything that has not started yet. Running renders are not interrupted.', inputSchema: { type: 'object', properties: {} }, handler: () => api('/cancel', { method: 'POST' }) },
  { name: 'sym_log', description: 'Last lines of the extension log (diagnostics).', inputSchema: { type: 'object', properties: { n: { type: 'number' } } }, handler: (a) => api('/log?n=' + (a.n || 60)) },
  { name: 'sym_api', description: 'Developer escape hatch: call a Symphony JSON endpoint from inside the signed-in tab (path relative to https://ads.tiktok.com). Use only when a documented tool cannot do it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, method: { type: 'string' }, body: { type: 'object' }, query: { type: 'object' } }, required: ['path'] }, handler: (a) => quick('api', a, 120) },
];
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
const spec = (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'You are the creative director for TikTok Symphony Creative Studio, not a silent executor. Reply in the user\'s language. ALWAYS call sym_status first: it returns `extension.director` — the director playbook sent by the SymFlow Chrome extension (TikTok ad formula, template usage, models and credit prices, avatars, dubbing, weekly credit budget). Follow it. If `extension.connected` is false — ask the user to install and open the SymFlow extension (https://lingoflow.pro/symflow) and to open ads.tiktok.com/creative/creativestudio signed in; if `license` is "expired" — ask them to activate a key, the queue resumes by itself. Credits are a weekly budget: read them in sym_status, name the cost before spending, and when a job fails with insufficient-credits tell the user how much is missing and when the free weekly credits renew. Workflow: 2–4 option questions → 2–3 ideas → dryRun → confirm cost → sym_generate/sym_avatar_video/… → sym_wait → show files → offer dubbing, avatars, edits. The playbook in sym_status is the single source of truth: when it and this note disagree, the playbook wins.',
      });
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS.map(spec) });
    case 'tools/call': {
      const tool = toolByName.get(String(params?.name || ''));
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try { const data = await tool.handler(params?.arguments || {}); return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data }); }
      catch (e) { return rpcResult(id, { content: [{ type: 'text', text: err(e) }], isError: true }); }
    }
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default: return isNotification ? null : rpcError(id, -32601, `Method not supported: ${method}`);
  }
}
async function main() {
  const b = await startBridge();
  log(b.already ? 'bridge already running — reusing' : 'bridge started', BASE);
  let buf = ''; let inFlight = 0; let ended = false;
  const maybeExit = () => { if (ended && inFlight === 0) process.exit(0); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { log('not JSON, skipping'); continue; }
      inFlight++;
      handle(msg).catch((e) => rpcError(msg?.id ?? null, -32603, (e && e.message) || 'internal error')).then((out) => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); }).finally(() => { inFlight--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
}
main().catch((e) => { log('fatal:', e); process.exit(1); });
