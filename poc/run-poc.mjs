// Phase 1 PoC gate runner.
//
// Proves two things before any feature code is written (spec §3):
//   1. An injected script runs under the workbench CSP.
//   2. The official TikTok iframe loads inside the workbench document and
//      postMessage events arrive back to the host page.
//
// Flow: backup workbench.html -> patch CSP + inject vibe-poc.js ->
// start collector on 127.0.0.1:47832 -> launch isolated VS Code window ->
// collect events -> restore original files -> verdict.
//
// usage: node run-poc.mjs [tiktokPostId]

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POST_ID = process.argv[2] || '7597942121538112799';
const COLLECT_MS = 30000;
const BRIDGE_PORT = 47832;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---------- locate install ----------
function findWorkbenchHtml() {
  const roots = [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
    'C:\\Program Files\\Microsoft VS Code',
  ];
  const candidates = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root); } catch { /* ignore */ }
    const dirs = ['', ...entries.filter((e) => !e.includes('.'))];
    for (const d of dirs) {
      const base = d ? join(root, d) : root;
      candidates.push(join(base, 'resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'));
      candidates.push(join(base, 'resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.html'));
    }
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function shaB64(buf) {
  return createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function walkUp(startDir, fileName) {
  let d = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, fileName))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

// ---------- events ----------
const events = [];
function push(kind, extra = {}) {
  const e = { t: Date.now(), kind, ...extra };
  events.push(e);
  console.log(`  [event] ${new Date(e.t).toISOString()} ${kind}${extra.origin ? ' origin=' + extra.origin : ''}${extra.data ? ' data=' + JSON.stringify(e.data).slice(0, 300) : ''}`);
}

// ---------- collector ----------
function startCollector() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (req.method === 'POST' && req.url.startsWith('/v1/poc')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try { push('report', JSON.parse(body)); } catch { push('report-raw', { raw: body.slice(0, 500) }); }
          res.writeHead(204, cors); res.end();
        });
        return;
      }
      res.writeHead(404, cors); res.end();
    });
    server.once('error', reject);
    server.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------- poc runtime (injected into workbench.html) ----------
function pocRuntime(postId) {
  return `/* vibe-poc: Phase 1 gate — proof of CSP execution + TikTok iframe messaging */
(function () {
  var ENDPOINT = '${BRIDGE}/v1/poc';
  function report(p) {
    try { fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(Object.assign({ t: Date.now() }, p)) }).catch(function () {}); }
    catch (e) {}
  }
  report({ kind: 'runtime-ok', href: location.href, csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]') });

  try {
    var iframe = document.createElement('iframe');
    iframe.src = 'https://www.tiktok.com/player/v1/${postId}?autoplay=1&loop=1&muted=1&controls=0&progress_bar=0';
    iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
    iframe.setAttribute('title', 'vibe-poc-tiktok');
    iframe.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:568px;z-index:2147483647;border:0;background:#000;pointer-events:none;';
    iframe.addEventListener('load', function () { report({ kind: 'iframe-load' }); });
    iframe.addEventListener('error', function () { report({ kind: 'iframe-error' }); });
    document.body.appendChild(iframe);
    report({ kind: 'iframe-appended' });
  } catch (e) {
    report({ kind: 'iframe-append-failed', err: String(e) });
  }

  var seen = {};
  window.addEventListener('message', function (ev) {
    var key = ev.origin + '|' + JSON.stringify(ev.data);
    if (seen[key]) return;
    seen[key] = 1;
    report({ kind: 'message', origin: ev.origin, data: ev.data });
  });

  setTimeout(function () { report({ kind: 'mark-10s' }); }, 10000);
  setTimeout(function () { report({ kind: 'mark-25s' }); }, 25000);
})();
`;
}

// ---------- patch ----------
function patchHtml(html, postId) {
  let out = html;
  // 1. extend frame-src with tiktok
  if (!/frame-src[^;]*tiktok\.com/.test(out)) {
    out = out.replace(/(frame-src[\s\S]*?;)/, (m) => m.replace(';', ' https://www.tiktok.com ;'));
  }
  // 2. extend connect-src + media-src with the local bridge
  if (!/connect-src[^;]*127\.0\.0\.1/.test(out)) {
    out = out.replace(/(connect-src[\s\S]*?;)/, (m) => m.replace(';', ` ${BRIDGE} ;`));
  }
  if (!/media-src[^;]*127\.0\.0\.1/.test(out)) {
    out = out.replace(/(media-src[\s\S]*?;)/, (m) => m.replace(';', ` ${BRIDGE} ;`));
  }
  // 3. inject the poc script after the startup script tag
  out = out.replace(
    /(<script src="\.\/workbench\.js"[^>]*><\/script>|<script src="\.\/workbench\.js"[^>]*\/>)/,
    (m) => `${m}\n\t<script src="./vibe-poc.js"></script>`
  );
  return out;
}

// ---------- main ----------
async function main() {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) { console.error('FATAL: workbench.html not found'); process.exit(3); }
  const appRoot = walkUp(dirname(htmlPath), 'product.json'); // .../resources/app
  const installRoot = walkUp(dirname(htmlPath), 'Code.exe');
  if (!appRoot || !installRoot) { console.error('FATAL: could not locate app root / install root'); process.exit(3); }
  console.log(`workbench: ${htmlPath}`);
  console.log(`app root : ${appRoot}`);
  console.log(`install  : ${installRoot}`);
  console.log(`post id  : ${POST_ID}`);

  const original = readFileSync(htmlPath);
  const pocJsPath = join(dirname(htmlPath), 'vibe-poc.js');
  const pjPath = join(appRoot, 'product.json');
  const pjOriginal = readFileSync(pjPath, 'utf8');

  const collector = await startCollector();
  push('collector-listening');

  try {
    // patch
    const patched = patchHtml(original.toString('utf8'), POST_ID);
    if (patched === original.toString('utf8')) { console.error('FATAL: patch produced no change'); process.exit(4); }
    writeFileSync(htmlPath, patched, 'utf8');
    writeFileSync(pocJsPath, pocRuntime(POST_ID), 'utf8');
    // update checksum so the corrupt-warning path is exercised with a correct hash
    const pj = JSON.parse(pjOriginal);
    const rel = relative(join(appRoot, 'out'), htmlPath).split('\\').join('/');
    if (pj.checksums && pj.checksums[rel]) {
      pj.checksums[rel] = shaB64(Buffer.from(patched, 'utf8'));
      writeFileSync(pjPath, JSON.stringify(pj, null, '\t') + '\n', 'utf8');
      console.log(`product.json checksum updated for ${rel}`);
    } else {
      console.log(`product.json has no checksum entry for ${rel} (skipping)`);
    }
    push('patched');

    // launch isolated vscode
    const codeExe = join(installRoot, 'Code.exe');
    const profile = join(__dirname, '.poc-profile');
    const extDir = join(__dirname, '.poc-ext');
    mkdirSync(profile, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    const smoke = join(__dirname, 'smoke-folder');
    mkdirSync(smoke, { recursive: true });
    writeFileSync(join(smoke, 'README.md'), '# vibe-poc smoke folder\n', 'utf8');

    console.log(`launching: ${codeExe}`);
    const child = spawn(codeExe, [
      '--user-data-dir', profile,
      '--extensions-dir', extDir,
      '--disable-workspace-trust',
      '-n',
      smoke,
    ], { detached: false, stdio: 'ignore' });
    push('vscode-spawned', { pid: child.pid });

    await sleep(COLLECT_MS);

    // kill isolated instance
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore */ }
    push('vscode-killed');
    await sleep(1500);
  } finally {
    // restore
    writeFileSync(htmlPath, original);
    writeFileSync(pjPath, pjOriginal, 'utf8');
    try { if (existsSync(pocJsPath)) unlinkSync(pocJsPath); } catch { /* ignore */ }
    collector.close();
    push('restored');
  }

  // verdict
  const kinds = new Set(events.map((e) => e.kind));
  const tiktokMsgs = events.filter((e) => e.kind === 'message' && e.origin && e.origin.includes('tiktok'));
  const otherMsgs = events.filter((e) => e.kind === 'message' && e.origin && !e.origin.includes('tiktok'));
  console.log('\n=== PoC VERDICT ===');
  console.log(`gate 1 (script runs under workbench CSP): ${kinds.has('runtime-ok') ? 'PASS' : 'FAIL'}`);
  const gate2 = kinds.has('iframe-load') || tiktokMsgs.length > 0;
  console.log(`gate 2 (TikTok iframe in workbench)    : ${gate2 ? 'PASS' : 'FAIL'}`);
  console.log(`  iframe appended: ${kinds.has('iframe-appended')}`);
  console.log(`  iframe load    : ${kinds.has('iframe-load')}`);
  console.log(`  iframe error   : ${kinds.has('iframe-error')}`);
  console.log(`  tiktok messages: ${tiktokMsgs.length}`);
  tiktokMsgs.slice(0, 10).forEach((m) => console.log(`    - ${JSON.stringify(m.data).slice(0, 300)}`));
  console.log(`  other messages : ${otherMsgs.length}`);
  console.log(`  total events   : ${events.length}`);
  process.exit(kinds.has('runtime-ok') && gate2 ? 0 : 1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
