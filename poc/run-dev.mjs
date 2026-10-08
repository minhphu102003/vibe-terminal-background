// Phase 4/5/6 integration runner: launches an isolated VS Code instance with
// this extension in development mode, waits for the workbench patch (run A),
// relaunches so the injected runtime boots (run B), drives the state bridge,
// and prints the collected diagnostics.
//
// usage: node run-dev.mjs

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '..');
const PROFILE = join(__dirname, '.dev-profile');
const SMOKE = join(__dirname, 'smoke-folder');
const DIAG = join(PROFILE, 'User', 'globalStorage', 'vibe-terminal.vibe-terminal-background', 'diagnostics.log');
const BRIDGE = 'http://127.0.0.1:47833'; // separate port so a live VS Code (47832) doesn't clash
const TIKTOK_URL = 'https://www.tiktok.com/@lifewithrusstie/video/7597942121538112799';

function findCodeExe() {
  const roots = [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
    'C:\\Program Files\\Microsoft VS Code',
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    if (existsSync(join(root, 'Code.exe'))) return { exe: join(root, 'Code.exe'), root };
  }
  throw new Error('Code.exe not found');
}

function prepare() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(join(PROFILE, 'User'), { recursive: true });
  mkdirSync(join(SMOKE, '.vscode'), { recursive: true });
  writeFileSync(
    join(PROFILE, 'User', 'settings.json'),
    JSON.stringify(
      {
        'security.workspace.trust.enabled': false,
        'task.allowAutomaticTasks': 'on',
        'terminal.integrated.enablePersistentSessions': false,
        'vibeTerminal.enabled': true,
        'vibeTerminal.bridgePort': 47833,
        'vibeTerminal.playlist': [join(PROJECT, 'poc', 'clip1.mp4'), TIKTOK_URL], // local first -> rotation under test
        'vibeTerminal.audio': 'stateful',
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(SMOKE, '.vscode', 'tasks.json'),
    JSON.stringify(
      {
        version: '2.0.0',
        tasks: [
          { label: 'smoke', type: 'shell', command: 'echo vibe-smoke', runOn: 'folderOpen', problemMatcher: [] },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(SMOKE, 'README.md'), '# vibe dev smoke folder\n', 'utf8');
  if (existsSync(DIAG)) rmSync(DIAG, { force: true });
}

function diagText() {
  try {
    return readFileSync(DIAG, 'utf8');
  } catch {
    return '';
  }
}

function launch(exe) {
  const child = spawn(
    exe,
    [
      '--user-data-dir',
      PROFILE,
      '--extensions-dir',
      join(__dirname, '.dev-ext'),
      `--extensionDevelopmentPath=${PROJECT}`,
      '-n',
      SMOKE,
    ],
    { stdio: 'ignore', env: { ...process.env, VIBE_DEV_SMOKE: '1' } },
  );
  return child;
}

function kill(child) {
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(diagText())) return true;
    await sleep(500);
  }
  console.log(`TIMEOUT waiting for: ${label}`);
  return false;
}

function bridgePost(path, body) {
  return new Promise((resolve) => {
    const req = request(
      `${BRIDGE}${path}`,
      { method: 'POST', headers: { 'content-type': 'text/plain' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

async function main() {
  // extension must be freshly built
  if (!existsSync(join(PROJECT, 'dist', 'extension.js')) || !existsSync(join(PROJECT, 'dist', 'injected', 'runtime.js'))) {
    console.error('dist missing — run `npm run build` first');
    process.exit(2);
  }
  const { exe } = findCodeExe();
  prepare();

  console.log('--- run A: extension activates and patches the workbench ---');
  let child = launch(exe);
  const patched = await waitFor(
    (t) => t.includes('workbench patched') || t.includes('workbench already patched') || t.includes('patch failed'),
    30000,
    'patch status',
  );
  kill(child);
  await sleep(1500);
  console.log(diagText().split('\n').filter(Boolean).slice(-10).join('\n'));
  if (!patched || diagText().includes('patch failed')) {
    console.error('VERDICT: patch FAILED');
    process.exit(1);
  }

  console.log('\n--- run B: patched workbench boots the injected runtime ---');
  child = launch(exe);
  const booted = await waitFor((t) => t.includes('runtime started') || t.includes('mounted into'), 60000, 'runtime boot');
  const mounted = await waitFor((t) => t.includes('diag stacking'), 90000, 'runtime diagnostics');
  if (booted) console.log('runtime booted');
  if (mounted) console.log('runtime mounted + diagnostics collected');

  // Multi-entry playlist: local clip plays first, ends, rotates to TikTok.
  const rotated = await waitFor((t) => t.includes('playlist -> entry 2/2'), 30000, 'playlist rotation');
  if (rotated) console.log('playlist rotated local -> tiktok');

  // Always drive the bridge (verifies SSE -> runtime -> player audio path).
  console.log('\n--- driving the state bridge ---');
  const okThinking = await bridgePost('/v1/state', JSON.stringify({ state: 'thinking', harness: 'poc' }));
  console.log(`POST thinking -> ${okThinking}`);
  await sleep(7000); // SSE round trip + player mute/unMute round trip
  const okInteractive = await bridgePost('/v1/state', JSON.stringify({ state: 'interactive', harness: 'poc' }));
  console.log(`POST interactive -> ${okInteractive}`);
  await sleep(4000);

  kill(child);
  await sleep(800);

  const lines = diagText().split('\n').filter(Boolean);
  console.log('\n=== diagnostics (all) ===');
  console.log(lines.join('\n'));

  const has = (s) => diagText().includes(s);
  console.log('\n=== VERDICT ===');
  const checks = [
    ['runtime booted under workbench CSP', has('runtime started')],
    ['terminal host found + mounted', has('mounted into')],
    ['xterm canvas probed', has('diag canvas')],
    ['stacking probe ran', has('diag stacking')],
    ['SSE connected (snapshot applied)', has('tiktok player mounted') || has('configuration updated') || has('state ->')],
    ['state thinking applied', has('state -> thinking')],
    ['state interactive applied', has('state -> interactive')],
    ['tiktok audio command round-trip', has('tiktok onMute=') || has('tiktok volume=')],
    ['local video served via /v1/media', has('local video mounted') && !has('video error')],
    ['playlist rotated local -> tiktok', has('playlist -> entry 2/2')],
  ];
  let fail = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) fail++;
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
