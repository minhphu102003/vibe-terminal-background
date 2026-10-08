// Isolation experiment: WHERE does the injected script execute?
//  - exp-body : same position as the production block (inside <body>)
//  - exp-tail : after the workbench.js script tag (PoC-proven position)
//  - runtime banner: the real runtime bundle's first statement
// Collector listens on 47832; no extension involved.
//
// usage: node run-exp.mjs

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 47832;

function findHtml() {
  const roots = [join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const sub of ['', ...readdirSync(root).filter((e) => !e.includes('.'))]) {
      const base = sub ? join(root, sub) : root;
      const html = join(base, 'resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html');
      if (existsSync(html)) return { html, dir: dirname(html) };
    }
  }
  throw new Error('workbench.html not found');
}

const hits = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { html, dir } = findHtml();
  console.log('html:', html);
  const original = readFileSync(html, 'utf8');

  const expBody = join(dir, 'vibe-exp-body.js');
  const expTail = join(dir, 'vibe-exp-tail.js');
  const probe = (tag) =>
    `try{fetch('http://127.0.0.1:${PORT}/v1/poc',{method:'POST',body:'${tag}'}).catch(function(){})}catch(e){}`;

  writeFileSync(expBody, probe('exp-body'), 'utf8');
  writeFileSync(expTail, probe('exp-tail'), 'utf8');

  // insert exp-body right after the production marker block (body position)
  let patched = original.replace('<!--VIBE-TERMINAL:end-->', '<!--VIBE-TERMINAL:end-->\n\t<script src="./vibe-exp-body.js"></script>');
  // insert exp-tail right after the workbench.js script (PoC position)
  patched = patched.replace(
    /(<script src="\.\/workbench\.js"[^>]*><\/script>)/,
    '$1\n\t<script src="./vibe-exp-tail.js"></script>',
  );
  if (patched === original) throw new Error('experiment patch made no change');
  writeFileSync(html, patched, 'utf8');
  console.log('experiment injected');

  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push(body);
        console.log('  hit:', body);
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
      });
    } else {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('collector on', PORT);

  const profile = join(__dirname, '.exp-profile');
  rmrf(profile);
  mkdirSync(join(profile, 'User'), { recursive: true });
  const smoke = join(__dirname, 'smoke-folder');
  mkdirSync(smoke, { recursive: true });

  const codeExe = join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  const child = spawn(codeExe, ['--user-data-dir', profile, '--extensions-dir', join(__dirname, '.exp-ext'), '-n', smoke], {
    stdio: 'ignore',
  });
  console.log('launched, collecting 20s...');
  await sleep(20000);
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  await sleep(1000);
  server.close();

  writeFileSync(html, original, 'utf8');
  unlinkSync(expBody);
  unlinkSync(expTail);
  console.log('restored');

  console.log('\n=== RESULT ===');
  console.log('hits:', JSON.stringify(hits));
  console.log('exp-body (production position):', hits.includes('exp-body') ? 'EXECUTED' : 'NOT EXECUTED');
  console.log('exp-tail (PoC position)       :', hits.includes('exp-tail') ? 'EXECUTED' : 'NOT EXECUTED');
  console.log('runtime banner (body pos)     :', hits.some((h) => h.includes('probe:script-executed')) ? 'EXECUTED' : 'NOT EXECUTED');
}

function rmrf(p) {
  try {
    spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', p], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
