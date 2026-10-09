// Aggregated unit tests (node:test) — run with `npm test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, mergeConfig, clamp01, toRuntimeConfig } from '../src/config/settings';
import { StateMachine, isVibeState } from '../src/bridge/stateMachine';
import { StateServer } from '../src/bridge/stateServer';
import { addCspSources, applyPatch, stripPatch, hasBlock, buildBlock, MARKER_BEGIN, cspAdditionsFor, PORT_SPAN } from '../src/patch/manifest';
import { extractTikTokId, isTikTokUrl, isUnresolvableTikTokShortLink, buildPlayerUrl } from '../src/tiktok/parser';
import { fetchTikTokMetadata, parseOembed } from '../src/tiktok/oembed';
import { TikTokMetadataCache } from '../src/tiktok/cache';
import { fitBox } from '../src/background/dimensions';
import { shouldMute } from '../src/injected/player';
import { buildClaudeSettings } from '../src/adapters/claude';
import { buildCodexConfig, buildCodexHooks } from '../src/adapters/codex';
import { buildOpenCodePlugin } from '../src/adapters/opencode';
import { buildPiHook } from '../src/adapters/pi';
import { curlPost, containsMarker, installFile, uninstallFile, backupPath, HARNESS_IDS } from '../src/adapters/common';
import { EVENT_MAP, installHarness, uninstallHarness } from '../src/adapters';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none' ;
  img-src 'self' data: blob: https: ;
  media-src 'self' ;
  frame-src 'self' vscode-webview: ;
  script-src 'self' 'unsafe-eval' blob: ;
  style-src 'self' 'unsafe-inline' ;
  connect-src 'self' https: ws: ;
"/>
</head>
<body></body>
<script src="./workbench.js" type="module"></script>
</html>`;

describe('patch/manifest', () => {
  it('adds CSP sources idempotently', () => {
    const once = addCspSources(SAMPLE_HTML.match(/content="([^"]*)"/)![1]!, {
      'frame-src': ['https://www.tiktok.com'],
      'connect-src': ['http://127.0.0.1:47832'],
      'media-src': ['http://127.0.0.1:47832'],
    });
    assert.match(once, /frame-src 'self' vscode-webview: https:\/\/www\.tiktok\.com/);
    assert.match(once, /connect-src 'self' https: ws: http:\/\/127\.0\.0\.1:47832/);
    const twice = addCspSources(once, {
      'frame-src': ['https://www.tiktok.com'],
      'connect-src': ['http://127.0.0.1:47832'],
      'media-src': ['http://127.0.0.1:47832'],
    });
    assert.equal(twice, once, 'second application must be a no-op');
  });

  it('applyPatch inserts marker block + extends CSP, stripPatch reverses it', () => {
    const patched = applyPatch(SAMPLE_HTML, { config: { a: 1 }, bridgePort: 47832 })!;
    assert.ok(patched);
    assert.ok(hasBlock(patched));
    assert.match(patched, /https:\/\/www\.tiktok\.com/);
    assert.match(patched, /vibe-terminal-runtime\.js/);
    assert.match(patched, /vibe-terminal-config/);
    // script-src untouched (no unsafe-inline added)
    assert.doesNotMatch(patched, /script-src[^;]*unsafe-inline[^;]*unsafe-inline/);

    const reverted = stripPatch(patched, 47832);
    assert.ok(!hasBlock(reverted));
    assert.doesNotMatch(reverted, /https:\/\/www\.tiktok\.com/);
    assert.doesNotMatch(reverted, /127\.0\.0\.1:47832/);
    // directive structure survives the round trip
    assert.match(reverted, /default-src 'none'/);
    assert.match(reverted, /frame-src 'self' vscode-webview:/);
  });

  it('CSP allows the full port range so sibling VS Code instances each bind a port', () => {
    const base = 47832;
    const adds = cspAdditionsFor(base);
    // frame-src is a single fixed origin
    assert.deepEqual(adds['frame-src'], ['https://www.tiktok.com']);
    // connect-src and media-src cover base..base+PORT_SPAN inclusive
    const expected = Array.from({ length: PORT_SPAN + 1 }, (_, i) => `http://127.0.0.1:${base + i}`);
    assert.deepEqual(adds['connect-src'], expected);
    assert.deepEqual(adds['media-src'], expected);
    assert.equal(expected.length, 29);
    // stripPatch removes the WHOLE range it added (idempotent round trip)
    const patched = applyPatch(SAMPLE_HTML, { config: {}, bridgePort: base })!;
    assert.match(patched, /http:\/\/127\.0\.0\.1:47860/);
    const reverted = stripPatch(patched, base);
    assert.doesNotMatch(reverted, /127\.0\.0\.1:47832/);
    assert.doesNotMatch(reverted, /127\.0\.0\.1:47860/);
  });

  it('re-patching replaces the existing block (single occurrence)', () => {
    const first = applyPatch(SAMPLE_HTML, { config: { a: 1 }, bridgePort: 47832 })!;
    const second = applyPatch(first, { config: { a: 2 }, bridgePort: 47832 })!;
    const count = second.split(MARKER_BEGIN).length - 1;
    assert.equal(count, 1);
    assert.match(second, /"a":2/);
  });

  it('embeds JSON safely (no script breakout)', () => {
    const block = buildBlock({ config: { evil: '</script><script>alert(1)</script>' }, bridgePort: 1 });
    assert.doesNotMatch(block, /<\/script><script>/);
    assert.match(block, /\\u003c/);
  });

  it('inserts before </body>', () => {
    const patched = applyPatch(SAMPLE_HTML, { config: {}, bridgePort: 1 })!;
    assert.ok(patched.indexOf(MARKER_BEGIN) < patched.indexOf('</body>'));
  });
});

describe('tiktok/parser', () => {
  it('extracts ids from supported URL shapes', () => {
    assert.equal(extractTikTokId('https://www.tiktok.com/@user/video/1234567890123456789'), '1234567890123456789');
    assert.equal(extractTikTokId('https://tiktok.com/@user/video/7597942121538112799?is_from_webapp=1'), '7597942121538112799');
    assert.equal(extractTikTokId('https://www.tiktok.com/embed/v1/7000000000000000000'), '7000000000000000000');
    assert.equal(extractTikTokId('https://www.tiktok.com/v/7000000000000000000'), '7000000000000000000');
  });

  it('rejects non-tiktok and short links', () => {
    assert.equal(extractTikTokId('https://example.com/video/1'), null);
    assert.equal(extractTikTokId('C:\\Videos\\clip.mp4'), null);
    assert.equal(isTikTokUrl('https://vm.tiktok.com/AbCdEf/'), false);
    assert.equal(isUnresolvableTikTokShortLink('https://vm.tiktok.com/AbCdEf/'), true);
    assert.equal(isUnresolvableTikTokShortLink('https://www.tiktok.com/@u/video/1'), false);
  });

  it('builds the official player URL with MVP params', () => {
    const single = buildPlayerUrl('123', { loop: true, muted: true });
    assert.match(single, /^https:\/\/www\.tiktok\.com\/player\/v1\/123\?/);
    assert.match(single, /loop=1/);
    assert.match(single, /muted=1/);
    assert.match(single, /autoplay=1/);
    assert.match(single, /controls=0/);
    assert.match(single, /fullscreen_button=0/);
    assert.match(buildPlayerUrl('123', { loop: false, muted: true }), /loop=0/);
    // stateful/unmuted audio must NOT lock volume via muted=1
    assert.match(buildPlayerUrl('123', { loop: true, muted: false }), /muted=0/);
  });
});

describe('background/dimensions', () => {
  it('cover fills the container and crops overflow', () => {
    // 9:16 content in a 16:9 container → width matches, height overflows
    const box = fitBox(1600, 900, 900, 1600, 'cover');
    assert.equal(Math.round(box.width), 1600);
    assert.ok(box.height >= 900);
    assert.ok(Math.abs(box.y) > 0 || box.height === 900);
  });

  it('contain letterboxes without cropping', () => {
    const box = fitBox(1600, 900, 900, 1600, 'contain');
    assert.equal(Math.round(box.height), 900);
    assert.ok(box.width < 1600);
    assert.ok(box.x > 0);
  });

  it('fill stretches to the container', () => {
    const box = fitBox(1600, 900, 900, 1600, 'fill');
    assert.deepEqual(box, { x: 0, y: 0, width: 1600, height: 900 });
  });

  it('guards degenerate sizes', () => {
    assert.deepEqual(fitBox(0, 0, 100, 100, 'cover'), { x: 0, y: 0, width: 0, height: 0 });
    assert.deepEqual(fitBox(100, 100, 0, 0, 'cover'), { x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('injected/player audio policy', () => {
  it('stateful follows state, fixed modes ignore it', () => {
    assert.equal(shouldMute('stateful', 'thinking'), false);
    assert.equal(shouldMute('stateful', 'interactive'), true);
    assert.equal(shouldMute('muted', 'thinking'), true);
    assert.equal(shouldMute('unmuted', 'interactive'), false);
  });
});

describe('config/settings', () => {
  it('merges empty input to defaults', () => {
    assert.deepEqual(mergeConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(mergeConfig({}), DEFAULT_CONFIG);
    assert.deepEqual(mergeConfig('junk'), DEFAULT_CONFIG);
  });

  it('clamps opacities and numeric ranges', () => {
    const c = mergeConfig({
      states: { thinking: { videoOpacity: 3, overlayOpacity: -1, textOpacity: 'x' } },
      transitionMs: 999999,
      bridgePort: 5,
      stateIdleFallbackSec: 1,
      idleFreezeSec: -5,
    });
    assert.equal(c.states.thinking.videoOpacity, 1);
    assert.equal(c.states.thinking.overlayOpacity, 0);
    assert.equal(c.states.thinking.textOpacity, DEFAULT_CONFIG.states.thinking.textOpacity);
    assert.equal(c.transitionMs, 5000);
    assert.equal(c.bridgePort, 1024);
    assert.equal(c.stateIdleFallbackSec, 10);
    assert.equal(c.idleFreezeSec, 0);
    assert.equal(c.states.interactive.textOpacity, 1);
    // 0 is a valid "disabled" value and must survive; over-max clamps down.
    assert.equal(mergeConfig({ idleFreezeSec: 0 }).idleFreezeSec, 0);
    assert.equal(mergeConfig({ idleFreezeSec: 999999 }).idleFreezeSec, 86400);
  });

  it('sanitizes playlist entries', () => {
    const c = mergeConfig({ playlist: ['  a.mp4 ', 42, null, '', 'https://www.tiktok.com/@u/video/1'] });
    assert.deepEqual(c.playlist, ['a.mp4', 'https://www.tiktok.com/@u/video/1']);
  });

  it('rejects invalid enums', () => {
    const c = mergeConfig({ fit: 'stretch', audio: 'loud' });
    assert.equal(c.fit, 'cover');
    assert.equal(c.audio, 'stateful');
  });

  it('toRuntimeConfig strips extension-only fields', () => {
    const rt = toRuntimeConfig(mergeConfig({ enabled: false, bridgePort: 5000, idleFreezeSec: 45 }));
    assert.equal('stateIdleFallbackSec' in rt, false);
    assert.equal(rt.enabled, false);
    assert.equal(rt.bridgePort, 5000);
    // idleFreezeSec IS consumed by the runtime (idle-freeze) so it must pass through.
    assert.equal(rt.idleFreezeSec, 45);
  });

  it('clamp01 fallbacks', () => {
    assert.equal(clamp01(Number.NaN, 0.5), 0.5);
    assert.equal(clamp01(0.25, 0), 0.25);
  });
});

describe('bridge/stateMachine', () => {
  function make(idleFallbackSec = 300, throttleMs = 0) {
    const events: Array<{ state: string; reason: string }> = [];
    const m = new StateMachine({
      idleFallbackSec,
      throttleMs,
      onChange: (e) => events.push({ state: e.state, reason: e.reason }),
    });
    return { m, events };
  }

  it('defaults to interactive (fail-safe)', () => {
    const { m } = make();
    assert.equal(m.state, 'interactive');
    m.dispose();
  });

  it('applies real harness events and clears simulation override', () => {
    const { m, events } = make();
    m.handle({ state: 'thinking', simulated: true });
    assert.equal(m.state, 'thinking');
    assert.equal(m.hasOverride, true);
    m.handle({ state: 'interactive', harness: 'claude' });
    assert.equal(m.state, 'interactive');
    assert.equal(m.hasOverride, false);
    assert.deepEqual(events.map((e) => e.reason), ['simulate', 'real-event']);
    m.dispose();
  });

  it('dedupes identical consecutive states', () => {
    const { m, events } = make();
    m.handle({ state: 'thinking' });
    m.handle({ state: 'thinking' });
    m.handle({ state: 'thinking' });
    assert.equal(events.length, 1);
    m.dispose();
  });

  it('idle fallback reverts stuck thinking to interactive', async () => {
    let t = Date.now();
    const events: Array<{ state: string; reason: string }> = [];
    const m = new StateMachine({
      idleFallbackSec: 1,
      throttleMs: 0,
      now: () => t,
      onChange: (e) => events.push({ state: e.state, reason: e.reason }),
    });
    m.handle({ state: 'thinking' });
    assert.equal(m.state, 'thinking');
    t += 1500; // jump past the 1s idle fallback window
    await new Promise((r) => setTimeout(r, 1100)); // let the 1s ticker run
    assert.equal(m.state, 'interactive');
    assert.equal(events.at(-1)?.reason, 'idle-fallback');
    m.dispose();
  });

  it('simulation override is not reverted by idle fallback', async () => {
    let t = Date.now();
    const m = new StateMachine({
      idleFallbackSec: 1,
      throttleMs: 0,
      now: () => t,
      onChange: () => undefined,
    });
    m.handle({ state: 'thinking', simulated: true });
    t += 5000;
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(m.state, 'thinking');
    m.dispose();
  });

  it('isVibeState guard', () => {
    assert.equal(isVibeState('thinking'), true);
    assert.equal(isVibeState('busy'), false);
    assert.equal(isVibeState(undefined), false);
  });

  it('throttles rapid changes: first emits immediately, burst collapses to one trailing emit', async () => {
    let t = 1_000_000;
    const events: string[] = [];
    const m = new StateMachine({
      idleFallbackSec: 300,
      throttleMs: 80,
      now: () => t,
      onChange: (e) => events.push(`${e.state}:${e.reason}`),
    });
    m.handle({ state: 'thinking' });
    m.handle({ state: 'interactive' });
    m.handle({ state: 'thinking' });
    assert.equal(events.length, 1); // burst collapsed behind the throttle window
    t += 500;
    await new Promise((r) => setTimeout(r, 130)); // trailing emit fires at ~80ms
    assert.equal(events.length, 2);
    assert.equal(events[1], 'thinking:real-event'); // latest state wins
    m.dispose();
  });
});

describe('bridge/stateServer', () => {
  function makeServer(port = 0) {
    const states: Array<{ state: string; harness?: string }> = [];
    const srv = new StateServer({
      port,
      onState: (state, harness) => states.push({ state, harness }),
      getSnapshot: () => ({ state: 'interactive', config: { ok: true } }),
    });
    return { srv, states };
  }

  function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, ms: number): Promise<string> {
    const dec = new TextDecoder();
    let buf = '';
    const read = (async () => {
      while (!buf.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      return buf;
    })();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), ms));
    return Promise.race([read, timeout]);
  }

  it('binds 127.0.0.1 exclusively (never 0.0.0.0)', async () => {
    const { srv } = makeServer();
    const port = await srv.start();
    try {
      assert.ok(port > 0);
      const addr = (srv as unknown as { server: { address(): unknown } | null }).server?.address();
      assert.ok(addr && typeof addr === 'object');
      assert.equal((addr as { address: string }).address, '127.0.0.1');
    } finally {
      await srv.stop();
    }
  });

  it('POST /v1/state accepts valid states and rejects others', async () => {
    const { srv, states } = makeServer();
    const port = await srv.start();
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/v1/state`, {
        method: 'POST',
        body: JSON.stringify({ state: 'thinking', harness: 'claude' }),
      });
      assert.equal(ok.status, 204);
      assert.deepEqual(states, [{ state: 'thinking', harness: 'claude' }]);

      const bad = await fetch(`http://127.0.0.1:${port}/v1/state`, {
        method: 'POST',
        body: JSON.stringify({ state: 'busy' }),
      });
      assert.equal(bad.status, 400);
      assert.equal(states.length, 1);
    } finally {
      await srv.stop();
    }
  });

  it('port conflict rejects with a clear error', async () => {
    const a = makeServer();
    const port = await a.srv.start();
    try {
      const b = makeServer(port);
      await assert.rejects(b.srv.start(), /already in use/);
    } finally {
      await a.srv.stop();
    }
  });

  it('GET /v1/config returns the snapshot', async () => {
    const { srv } = makeServer();
    const port = await srv.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/config`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { state: 'interactive', config: { ok: true }, player: null });
    } finally {
      await srv.stop();
    }
  });

  it('POST /v1/player records the runtime playlist position', async () => {
    const { srv } = makeServer();
    const port = await srv.start();
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/v1/player`, {
        method: 'POST',
        body: JSON.stringify({ index: 1, total: 3, source: 'E:/clip.mp4' }),
      });
      assert.equal(ok.status, 204);
      assert.deepEqual(
        { ...srv.playerPosition, at: 0 },
        { index: 1, total: 3, source: 'E:/clip.mp4', at: 0 },
      );

      const bad = await fetch(`http://127.0.0.1:${port}/v1/player`, {
        method: 'POST',
        body: JSON.stringify({ index: 5, total: 3, source: '' }),
      });
      assert.equal(bad.status, 400);
      assert.equal(srv.playerPosition?.index, 1);

      const cfg = await (await fetch(`http://127.0.0.1:${port}/v1/config`)).json();
      assert.equal((cfg as { player: { index: number } }).player.index, 1);
    } finally {
      await srv.stop();
    }
  });

  it('SSE /v1/events streams a snapshot and receives broadcasts', async () => {
    const { srv } = makeServer();
    const port = await srv.start();
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = res.body!.getReader();
      const first = await readUntil(reader, '\n\n', 3000);
      assert.match(first, /"type":"snapshot"/);

      srv.broadcast('state', { state: 'thinking' });
      const second = await readUntil(reader, '\n\n', 3000);
      assert.match(second, /thinking/);
    } finally {
      ac.abort();
      await srv.stop();
    }
  });

  it('media requests outside the allow-list 404', async () => {
    const { srv } = makeServer();
    const port = await srv.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/media/${encodeURIComponent('E:/secret.mp4')}`);
      assert.equal(res.status, 404);
    } finally {
      await srv.stop();
    }
  });
});

describe('tiktok/oembed', () => {
  const URL_ = 'https://www.tiktok.com/@user/video/7597942121538112799';

  it('parses an oEmbed payload into normalized metadata', async () => {
    const meta = await fetchTikTokMetadata(URL_, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          title: 'clip',
          author_name: 'user',
          width: 720,
          height: 1280,
          thumbnail_url: 'https://cdn.example/t.jpg',
        }),
      }),
    });
    assert.ok(meta);
    assert.equal(meta.id, '7597942121538112799');
    assert.equal(meta.originalUrl, URL_);
    assert.equal(meta.title, 'clip');
    assert.equal(meta.authorName, 'user');
    assert.equal(meta.width, 720);
    assert.equal(meta.height, 1280);
    assert.equal(meta.thumbnailUrl, 'https://cdn.example/t.jpg');
    assert.equal(meta.playerUrl, 'https://www.tiktok.com/player/v1/7597942121538112799');
  });

  it('returns null for non-TikTok URLs, HTTP errors, and fetch failures', async () => {
    assert.equal(
      await fetchTikTokMetadata('https://example.com/v', {
        fetchImpl: async () => {
          throw new Error('must not be called for non-TikTok urls');
        },
      }),
      null,
    );
    assert.equal(
      await fetchTikTokMetadata(URL_, {
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      }),
      null,
    );
    assert.equal(
      await fetchTikTokMetadata(URL_, {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
      null,
    );
  });

  it('parseOembed tolerates junk payloads', () => {
    const m = parseOembed('123456', URL_, null);
    assert.equal(m.id, '123456');
    assert.equal(m.playerUrl, 'https://www.tiktok.com/player/v1/123456');
    assert.equal(m.title, undefined);
    assert.equal(m.width, undefined);
    const junk = parseOembed('123456', URL_, { title: 42, width: 'x', height: -1 });
    assert.equal(junk.title, undefined);
    assert.equal(junk.width, undefined);
  });
});

describe('tiktok/cache', () => {
  const META = parseOembed('7597942121538112799', 'https://www.tiktok.com/@u/video/7597942121538112799', {
    title: 'clip',
    width: 720,
    height: 1280,
  });

  it('round-trips metadata and honors TTL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-cache-'));
    try {
      let now = 1_000_000_000;
      const cache = new TikTokMetadataCache(dir, 24 * 60 * 60 * 1000, () => now);
      cache.set(META);
      assert.deepEqual(cache.get(META.id), META);
      now += 25 * 60 * 60 * 1000; // past the 24h TTL
      assert.equal(cache.get(META.id), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing and corrupt entries return null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-cache-'));
    try {
      const cache = new TikTokMetadataCache(dir);
      assert.equal(cache.get('000000'), null);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '000001.json'), '{ not json', 'utf8');
      assert.equal(cache.get('000001'), null);
      writeFileSync(join(dir, '000002.json'), JSON.stringify({ id: '000002' }), 'utf8'); // no resolvedAt
      assert.equal(cache.get('000002'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cache lookup enriches runtime playlist entries', () => {
    const cfg = mergeConfig({ playlist: ['https://www.tiktok.com/@u/video/7597942121538112799', 'C:\\v\\clip.mp4'] });
    const rt = toRuntimeConfig(cfg, (id) => (id === META.id ? { width: 720, height: 1280 } : null));
    assert.equal(rt.playlist[0]?.width, 720);
    assert.equal(rt.playlist[0]?.height, 1280);
    assert.equal(rt.playlist[1]?.kind, 'local');
    assert.equal(rt.playlist[1]?.width, undefined);
  });
});

describe('adapters/builders', () => {
  const PORT = 47832;

  it('claude builder merges hooks, preserves user data, and is idempotent', () => {
    const user = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-cmd' }] }] },
      permissions: { allow: ['Bash'] },
    };
    const once = buildClaudeSettings(JSON.stringify(user, null, 2), PORT);
    const parsed = JSON.parse(once) as Record<string, unknown>;
    assert.equal(parsed.model, 'opus');
    assert.deepEqual(parsed.permissions, { allow: ['Bash'] });
    const stop = (parsed.hooks as Record<string, unknown[]>).Stop;
    assert.equal(stop.length, 2); // user group untouched + ours appended
    assert.ok(stop.some((g) => String(JSON.stringify(g)).includes('user-cmd')));
    assert.ok(once.includes('/v1/state'));
    assert.ok(once.includes('PreToolUse'));
    assert.ok(once.includes('permission_prompt|idle_prompt|elicitation_'));
    assert.equal(buildClaudeSettings(once, PORT), once);
  });

  it('claude builder rejects non-object roots', () => {
    assert.throws(() => buildClaudeSettings('[1,2]', PORT));
    assert.throws(() => buildClaudeSettings('"nope"', PORT));
    assert.equal(buildClaudeSettings(null, PORT), buildClaudeSettings('', PORT));
  });

  it('codex hooks builder merges into existing hooks.json', () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'legacy-stop' }] }] } };
    const once = buildCodexHooks(JSON.stringify(user), PORT);
    const parsed = JSON.parse(once) as { hooks: Record<string, { hooks: { command?: string }[] }[]> };
    assert.ok(once.includes('legacy-stop'));
    assert.equal(parsed.hooks.Stop.length, 2);
    assert.ok(once.includes('Interrupt'));
    const pre = parsed.hooks.PreToolUse ?? [];
    assert.ok(
      pre.some((g) => g.hooks.some((h) => h.command === curlPost(PORT, 'thinking', 'codex'))),
      'thinking curl command must be embedded verbatim',
    );
    assert.equal(buildCodexHooks(once, PORT), once);
  });

  it('codex config builder inserts flag inside [features] without duplicating keys', () => {
    const withFeatures = '[model]\nvalue = "x"\n\n[features]\nweb_search = true\n';
    const built = buildCodexConfig(withFeatures);
    assert.ok(built.includes('[features]'));
    const idxFeatures = built.indexOf('[features]');
    const idxFlag = built.indexOf('codex_hooks = true');
    assert.ok(idxFeatures < idxFlag);
    assert.equal((built.match(/codex_hooks = true/g) ?? []).length, 1);
    assert.equal((built.match(/\[features\]/g) ?? []).length, 1);
    assert.ok(built.includes('# >>> vibe-terminal >>>'));
    assert.equal(buildCodexConfig(built), built);

    const bare = 'model = "x"\n';
    const bareBuilt = buildCodexConfig(bare);
    assert.ok(bareBuilt.startsWith('model = "x"'));
    assert.ok(bareBuilt.includes('\n[features]\n'));
    assert.equal(buildCodexConfig(bareBuilt), bareBuilt);

    const flagged = '[features]\ncodex_hooks = true\n';
    assert.equal(buildCodexConfig(flagged), flagged); // already set — never duplicate
    assert.equal(buildCodexConfig(null), buildCodexConfig('   '));
  });

  it('opencode and pi builders embed marker, port, and their events', () => {
    const oc = buildOpenCodePlugin(PORT);
    assert.ok(oc.includes('// >>> vibe-terminal >>>'));
    assert.ok(oc.includes(`127.0.0.1:${PORT}`));
    assert.ok(oc.includes("'session.idle'") && oc.includes("'tool.execute.before'"));
    const pi = buildPiHook(PORT);
    assert.ok(pi.includes('// >>> vibe-terminal >>>'));
    assert.ok(pi.includes(`127.0.0.1:${PORT}`));
    assert.ok(pi.includes("pi.on('agent_start'") && pi.includes("pi.on('session_shutdown'"));
  });

  it('curlPost matches the spec hook shape', () => {
    const cmd = curlPost(PORT, 'thinking', 'claude');
    assert.ok(cmd.startsWith('curl.exe -m 1 -s -o NUL -X POST '));
    assert.ok(cmd.includes(`http://127.0.0.1:${PORT}/v1/state`));
    assert.ok(cmd.includes('-H "Content-Type: application/json"'));
    assert.ok(cmd.includes('-d "{\\"state\\":\\"thinking\\",\\"harness\\":\\"claude\\"}"'));
  });
});

describe('adapters/install', () => {
  const PORT = 47832;

  it('shared config round-trips byte-for-byte through install/uninstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-adp-'));
    try {
      const file = join(dir, 'settings.json');
      const original = '{\n  "model": "opus"\n}\n';
      writeFileSync(file, original, 'utf8');

      const first = installFile(file, (e) => buildClaudeSettings(e, PORT));
      assert.equal(first.status, 'installed');
      assert.ok(existsSync(backupPath(file)));
      assert.ok(containsMarker(readFileSync(file, 'utf8')));
      assert.notEqual(readFileSync(file, 'utf8'), original);

      const again = installFile(file, (e) => buildClaudeSettings(e, PORT));
      assert.equal(again.status, 'already');
      assert.equal(readFileSync(backupPath(file), 'utf8'), original); // pristine backup kept

      const un = uninstallFile(file);
      assert.equal(un.status, 'restored');
      assert.equal(readFileSync(file, 'utf8'), original);
      assert.ok(!existsSync(backupPath(file)));
      assert.equal(uninstallFile(file).status, 'nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('created files are deleted on uninstall; foreign files are left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-adp-'));
    try {
      const fresh = join(dir, 'new.json');
      assert.equal(installFile(fresh, (e) => buildClaudeSettings(e, PORT)).status, 'created');
      assert.ok(!existsSync(backupPath(fresh)));
      assert.equal(uninstallFile(fresh).status, 'deleted');
      assert.ok(!existsSync(fresh));

      const foreign = join(dir, 'foreign.json');
      writeFileSync(foreign, '{"other": true}', 'utf8');
      assert.equal(uninstallFile(foreign).status, 'nothing');
      assert.ok(existsSync(foreign));

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{"x":1}', 'utf8');
      const failed = installFile(bad, () => {
        throw new Error('boom');
      });
      assert.equal(failed.status, 'failed');
      assert.ok(failed.detail?.includes('boom'));
      assert.equal(readFileSync(bad, 'utf8'), '{"x":1}'); // no side effects
      assert.ok(!existsSync(backupPath(bad)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('owned file refusal: existing file without our marker is never overwritten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-adp-'));
    try {
      const home = dir;
      const file = join(home, '.config', 'opencode', 'plugins', 'vibe-state.ts');
      mkdirSync(join(home, '.config', 'opencode', 'plugins'), { recursive: true });
      writeFileSync(file, 'export const other = 1;\n', 'utf8');
      const res = installHarness('opencode', { home, port: PORT });
      assert.equal(res[0]?.status, 'failed');
      assert.equal(readFileSync(file, 'utf8'), 'export const other = 1;\n');
      assert.ok(!existsSync(backupPath(file)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installHarness creates the full claude file tree and uninstalls it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-adp-'));
    try {
      const home = dir;
      const file = join(home, '.claude', 'settings.json');
      const installed = installHarness('claude', { home, port: PORT });
      assert.deepEqual(installed.map((r) => r.status), ['created']);
      assert.ok(existsSync(file));
      assert.ok(containsMarker(readFileSync(file, 'utf8')));
      assert.deepEqual(
        installHarness('claude', { home, port: PORT }).map((r) => r.status),
        ['already'],
      );
      const removed = uninstallHarness('claude', { home, port: PORT });
      assert.deepEqual(removed.map((r) => r.status), ['deleted']);
      assert.ok(!existsSync(file));
      assert.deepEqual(
        uninstallHarness('claude', { home, port: PORT }).map((r) => r.status),
        ['nothing'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codex harness writes both files and restores both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-adp-'));
    try {
      const home = dir;
      writeFileSync(join(dir, 'keep.txt'), 'data', 'utf8');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o"\n', 'utf8');

      const res = installHarness('codex', { home, port: PORT });
      assert.deepEqual(res.map((r) => r.status), ['created', 'installed']);
      const hooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')) as {
        hooks: Record<string, { hooks: { command?: string }[] }[]>;
      };
      assert.ok(
        (hooks.hooks.Stop ?? []).some((g) =>
          g.hooks.some((h) => h.command === curlPost(PORT, 'interactive', 'codex')),
        ),
        'interactive curl command must be embedded verbatim',
      );
      const cfg = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
      assert.ok(cfg.startsWith('model = "o"'));
      assert.ok(cfg.includes('codex_hooks = true'));

      const back = uninstallHarness('codex', { home, port: PORT });
      assert.deepEqual(back.map((r) => r.status), ['deleted', 'restored']);
      assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
      assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), 'model = "o"\n');
      assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('event map covers every harness id with valid states', () => {
    for (const id of HARNESS_IDS) {
      const m = EVENT_MAP[id];
      assert.ok(m, `missing EVENT_MAP for ${id}`);
      assert.ok(m.thinking.length > 0 && m.interactive.length > 0);
    }
    assert.equal(Object.keys(EVENT_MAP).length, HARNESS_IDS.length);
  });
});
