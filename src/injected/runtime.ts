// Injected workbench runtime (spec §3, §4, §11, §12, §15, §19, §20).
// Bundled to a plain script and loaded from the patched workbench HTML.
// DOM APIs only — Trusted Types forbids innerHTML in this document.

import type { RuntimeConfig, VibeState } from '../config/settings';
import { PlayerManager } from './player';
import { HOST_CLASS, ROOT_CLASS, applyConfigVars, applyStateVars, ensureStyle, setHostState } from './visuals';

const HOST_SELECTORS = ['.terminal-groups-container', '.terminal-outer-container'];
const DEFAULT_STATE: VibeState = 'interactive';

const DEFAULT_CONFIG: RuntimeConfig = {
  enabled: false,
  playlist: [],
  fit: 'cover',
  loop: true,
  audio: 'stateful',
  transitionMs: 350,
  bridgePort: 47832,
  states: {
    thinking: { videoOpacity: 0.85, overlayOpacity: 0.1, textOpacity: 0.4 },
    interactive: { videoOpacity: 0.15, overlayOpacity: 0.55, textOpacity: 1.0 },
  },
};

interface BridgeMessage {
  type?: string;
  state?: VibeState;
  config?: RuntimeConfig;
}

class VibeRuntime {
  // Unique per renderer instance — makes duplicate-boot / multi-window
  // anomalies visible in the aggregated diagnostics log.
  readonly uid = Math.random().toString(36).slice(2, 8);
  private static count = 0;
  readonly inst = ++VibeRuntime.count;
  private logCalls = 0;
  private started = false;
  private cfg: RuntimeConfig = DEFAULT_CONFIG;
  private state: VibeState = DEFAULT_STATE;

  get bridgePort(): number {
    return this.cfg.bridgePort;
  }

  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private players: PlayerManager | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private source: EventSource | null = null;
  private sseWatchdog: ReturnType<typeof setInterval> | null = null;
  private sseStuckSince: number | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private portDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationObserver: MutationObserver | null = null;
  private diagDone = false;
  private missCount = 0;
  private readonly logQueue: string[] = [];
  private logFlush: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.cfg = this.readEmbeddedConfig();
    ensureStyle(document);
    this.log(
      `runtime started#${this.uid} inst=${this.inst} calls=${this.logCalls} (enabled=${String(this.cfg.enabled)}, entries=${this.cfg.playlist.length})`,
    );
    this.watchDom();
    // The bridge may not be listening yet during early boot — queue + retry.
    this.logFlush = setInterval(() => this.flushLogs(), 300);
    (this.logFlush as { unref?: () => void }).unref?.();
    // Discover THIS window's bridge port before connecting. The workbench.html
    // is shared by every VS Code window, so the port embedded in it cannot be
    // trusted — the extension publishes the real bound port in the status bar.
    this.discoverAndConnect(0);
  }

  /**
   * The extension writes `vibe-bridge:<port>` into this window's status bar.
   * Reading it from the DOM is the only per-window channel the injected
   * runtime has (the HTML + CSP are shared across all windows).
   */
  private discoverPort(): number | null {
    try {
      const sb = document.querySelector('.statusbar');
      if (!sb) return null;
      const m = /vibe-bridge:(\d{4,5})/.exec(sb.textContent || '');
      if (m && m[1]) return parseInt(m[1], 10);
    } catch {
      /* ignore */
    }
    return null;
  }

  private static readonly PORT_DISCOVERY_ATTEMPTS = 40; // 40 * 250ms = 10s
  private static readonly PORT_DISCOVERY_INTERVAL_MS = 250;

  private discoverAndConnect(attempt: number): void {
    const port = this.discoverPort();
    if (port) {
      if (port !== this.cfg.bridgePort) {
        this.log(`bridge port discovered: ${this.cfg.bridgePort} -> ${port}`);
        this.cfg = { ...this.cfg, bridgePort: port };
      }
      this.scan();
      this.connect();
      this.scanTimer = setInterval(() => this.scan(), 5000);
      (this.scanTimer as { unref?: () => void }).unref?.();
      return;
    }
    if (attempt >= VibeRuntime.PORT_DISCOVERY_ATTEMPTS) {
      this.log(`bridge port discovery timed out — falling back to embedded ${this.cfg.bridgePort}`);
      this.scan();
      this.connect();
      this.scanTimer = setInterval(() => this.scan(), 5000);
      (this.scanTimer as { unref?: () => void }).unref?.();
      return;
    }
    this.portDiscoveryTimer = setTimeout(
      () => this.discoverAndConnect(attempt + 1),
      VibeRuntime.PORT_DISCOVERY_INTERVAL_MS,
    );
  }

  // ---- config / state -------------------------------------------------

  private readEmbeddedConfig(): RuntimeConfig {
    try {
      const el = document.getElementById('vibe-terminal-config');
      if (!el || !el.textContent) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...(JSON.parse(el.textContent) as RuntimeConfig) };
    } catch (err) {
      this.log(`config parse failed: ${String(err)}`);
      return { ...DEFAULT_CONFIG };
    }
  }

  private bridge(): string {
    return `http://127.0.0.1:${this.cfg.bridgePort}`;
  }

  /**
   * Queue log lines and flush them to the bridge every 300ms.
   * Survives (a) the bridge not yet listening during early boot and
   * (b) bursts of diagnostic lines — nothing is dropped, consecutive
   * duplicates collapse.
   */
  private log(msg: string): void {
    this.logCalls++;
    try {
      console.debug(`[vibe-terminal] ${msg}`);
    } catch {
      /* console unavailable */
    }
    const line = `[runtime] ${msg}`;
    if (this.logQueue[this.logQueue.length - 1] === line) return;
    this.logQueue.push(line);
    if (this.logQueue.length > 200) this.logQueue.splice(0, this.logQueue.length - 200);
  }

  /** Log + flush immediately — used for SSE lifecycle lines so diagnostics
   *  timestamps reflect event time, not the 300ms queue lag. */
  private logNow(msg: string): void {
    this.log(msg);
    this.flushLogs();
  }

  private sending = false;

  private flushLogs(): void {
    if (this.sending) return;
    if (this.logQueue.length === 0) return;
    const line = this.logQueue[0];
    if (line === undefined) return;
    this.sending = true;
    try {
      void fetch(`${this.bridge()}/v1/log`, { method: 'POST', body: line })
        .then((res) => {
          if (res.ok || res.status === 204) this.logQueue.shift();
        })
        .catch(() => {
          /* bridge down — keep the line queued */
        })
        .finally(() => {
          this.sending = false;
        });
    } catch {
      this.sending = false;
    }
  }

  private connect(): void {
    this.createSource();
    if (!this.sseWatchdog) {
      this.sseWatchdog = setInterval(() => this.sseGuard(), 1000);
      (this.sseWatchdog as { unref?: () => void }).unref?.();
    }
  }

  /**
   * EventSource auto-retries on its own but with browser backoff (observed
   * multi-second gaps when the bridge starts after the workbench). This guard
   * bounds self-heal without fighting that backoff: CONNECTING gets a 5s
   * grace period (EventSource retries itself), CLOSED is recreated at once.
   */
  private sseGuard(): void {
    const state = this.source?.readyState ?? -1;
    if (state === EventSource.OPEN) {
      this.sseStuckSince = null;
      return;
    }
    if (state === EventSource.CLOSED) {
      this.logNow(`sse\ guard: closed -> recreate`);
      this.sseStuckSince = null;
      this.createSource();
      return;
    }
    // CONNECTING (or no source): grace period, then force one attempt.
    const now = Date.now();
    if (this.sseStuckSince === null) {
      this.sseStuckSince = now;
      return;
    }
    if (now - this.sseStuckSince < 5000) return;
    this.logNow(`sse\ guard: connecting\ >5s -> recreate`);
    this.sseStuckSince = null;
    this.createSource();
  }

  private createSource(): void {
    try {
      const prev = this.source;
      this.source = null;
      try {
        prev?.close();
      } catch {
        /* already dead */
      }
      this.source = new EventSource(`${this.bridge()}/v1/events`);
    } catch (err) {
      this.logNow(`sse\ connect\ failed: ${String(err)}`);
      return;
    }
    this.source.onopen = () => {
      this.logNow(`sse\ open#${this.uid} t=${Date.now()}`);
    };
    this.source.onmessage = (ev: MessageEvent<string>) => {
      try {
        this.handleMessage(JSON.parse(ev.data) as BridgeMessage);
      } catch {
        /* ignore malformed */
      }
    };
    this.source.onerror = () => {
      // EventSource retries automatically; the guard above bounds the wait.
      this.logNow(`sse\ reconnecting#${this.uid} readyState=${this.source?.readyState ?? -1}`);
    };
  }

  private handleMessage(msg: BridgeMessage): void {
    switch (msg.type) {
      case 'snapshot':
        if (msg.config) this.applyNewConfig(msg.config);
        if (msg.state) this.setState(msg.state);
        break;
      case 'state':
        if (msg.state) this.setState(msg.state);
        break;
      case 'config':
        if (msg.config) this.applyNewConfig(msg.config);
        break;
      case 'reload':
        this.players?.reload();
        break;
      default:
        break;
    }
  }

  private applyNewConfig(next: RuntimeConfig): void {
    this.cfg = { ...DEFAULT_CONFIG, ...next };
    if (!this.cfg.enabled) {
      this.teardown();
      return;
    }
    if (!this.host) this.scan();
    if (this.root) applyConfigVars(this.root, this.cfg);
    this.players?.configure(this.cfg);
    if (this.root) applyStateVars(this.root, this.cfg, this.state);
    this.layout();
  }

  private setState(next: VibeState): void {
    if (this.state === next) return;
    this.state = next;
    this.log(`state -> ${next}#${this.uid}`);
    this.stateApplied();
  }

  private stateApplied(): void {
    if (this.host) setHostState(this.host, this.state);
    if (this.root) {
      applyStateVars(this.root, this.cfg, this.state);
      const s = this.root.style;
      this.log(
        `vis ${this.state} video=${s.getPropertyValue('--vibe-video-opacity')} overlay=${s.getPropertyValue('--vibe-overlay-opacity')} text=${s.getPropertyValue('--vibe-text-opacity')}`,
      );
    }
    this.players?.setState(this.state);
  }

  // ---- mounting -------------------------------------------------------

  private scan(): void {
    if (!this.cfg.enabled) return;

    if (this.host && this.host.isConnected) return; // still valid

    const host = this.findHost();
    if (host === this.host && this.root && this.root.isConnected) return;
    if (!host) {
      this.missCount++;
      if (this.missCount <= 3 || this.missCount % 12 === 0) {
        const term = Array.from(document.querySelectorAll('[class*=terminal]'));
        const sample = term
          .slice(0, 4)
          .map((el) => `.${(el.className || '').toString().trim().split(/\s+/)[0] ?? ''}`)
          .join(',');
        this.log(
          `scan miss#${this.missCount} xterm=${document.querySelectorAll('.xterm').length} terminalish=${term.length} groups=${document.querySelectorAll('.terminal-groups-container').length} [${sample}]`,
        );
      }
      return;
    }
    this.mount(host);
  }

  private findHost(): HTMLElement | null {
    for (const selector of HOST_SELECTORS) {
      const all = document.querySelectorAll<HTMLElement>(selector);
      for (const el of all) {
        if (el.getClientRects().length > 0) return el;
      }
      if (all.length > 0) return all[0] ?? null;
    }
    return null;
  }

  private mount(host: HTMLElement | null): void {
    this.teardown(false);
    if (!host) return;

    this.host = host;
    host.classList.add(HOST_CLASS);

    const root = document.createElement('div');
    root.className = ROOT_CLASS;
    const overlay = document.createElement('div');
    overlay.className = 'vibe-overlay';
    root.appendChild(overlay);
    host.insertBefore(root, host.firstChild);
    this.root = root;

    const players = new PlayerManager(root, {
      onLog: (m) => this.log(m),
      onIndex: (index, total, source) => {
        try {
          void fetch(`${this.bridge()}/v1/player`, {
            method: 'POST',
            body: JSON.stringify({ index, total, source }),
          }).catch(() => undefined);
        } catch {
          /* bridge down — position is cosmetic */
        }
      },
    });
    this.players = players;
    players.configure(this.cfg);
    players.setState(this.state);

    applyConfigVars(root, this.cfg);
    applyStateVars(root, this.cfg, this.state);
    setHostState(host, this.state);

    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(root);
    this.intersectionObserver = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible) this.players?.play();
      else this.players?.pause();
    });
    this.intersectionObserver.observe(host);

    this.layout();
    this.log(`mounted into <${host.tagName.toLowerCase()} class="${host.className}">`);
    void this.runDiagnostics(host);
  }

  private layout(): void {
    if (!this.root || !this.players) return;
    this.players.resize(this.root.clientWidth, this.root.clientHeight);
  }

  private teardown(removeHostFlags = true): void {
    if (this.portDiscoveryTimer) {
      clearTimeout(this.portDiscoveryTimer);
      this.portDiscoveryTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.players?.dispose();
    this.players = null;
    this.root?.remove();
    this.root = null;
    if (removeHostFlags && this.host) {
      this.host.classList.remove(HOST_CLASS);
      this.host.removeAttribute('data-vibe-state');
    }
    this.host = null;
  }

  private watchDom(): void {
    let queued = false;
    this.mutationObserver = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        this.scan();
      }, 300);
    });
    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- diagnostics (PoC + support) ------------------------------------

  private async runDiagnostics(host: HTMLElement): Promise<void> {
    if (this.diagDone) return;
    this.diagDone = true;

    // Give xterm a moment to attach its canvas.
    for (let i = 0; i < 10; i++) {
      if (host.querySelector('canvas')) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const probe = (selector: string): string => {
      const el = host.querySelector(selector) ?? document.querySelector(selector);
      if (!el) return `${selector}: <none>`;
      const cs = getComputedStyle(el);
      return `${selector}: bg=${cs.backgroundColor} position=${cs.position} z=${cs.zIndex}`;
    };

    this.log(`diag host=${host.className}`);

    // Renderer matters: webgl/canvas draw an opaque terminal background into a
    // full-size <canvas> above the video — only the DOM renderer leaves gaps.
    const mainCanvas = [...host.querySelectorAll<HTMLCanvasElement>('.xterm canvas')].find(
      (c) => !c.className && c.width > 300 && c.height > 50,
    );
    this.log(
      mainCanvas
        ? 'renderer=webgl/canvas (OPAQUE canvas covers video — set terminal.integrated.gpuAcceleration=off)'
        : 'renderer=dom (transparent — video visible)',
    );
    for (const sel of ['.terminal-outer-container', '.terminal-wrapper', '.xterm', '.xterm-screen', '.xterm-viewport']) {
      this.log(`diag ${probe(sel)}`);
    }

    // Who sits on top of the video at the host centre? Walk the FULL hit stack
    // and flag every layer with an opaque background (the real occluders).
    try {
      const hx = host.getBoundingClientRect();
      const stack = document.elementsFromPoint(hx.left + hx.width / 2, hx.top + hx.height / 2);
      const opaque = stack
        .map((el) => ({ el, cs: getComputedStyle(el) }))
        // Ancestors of the video root paint behind it — they never occlude.
        .filter(({ el }) => !(this.root && el !== this.root && el.contains(this.root)))
        // Cells/widgets inside the text layer are content and stay opaque by design
        // (the screen element itself is still eligible — it must stay transparent).
        .filter(({ el }) => {
          const inScreen = el.closest('.xterm-screen');
          return !inScreen || inScreen === el;
        })
        .filter(({ cs }) => {
          const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
          const alpha = m?.[1] ? Number(m[1].split(',')[3]?.trim() ?? 1) : 1;
          return alpha > 0.05;
        })
        .map(({ el, cs }) => {
          const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : el.tagName;
          return `${el.tagName.toLowerCase()}.${cls} bg=${cs.backgroundColor} z=${cs.zIndex}/${cs.position}`;
        });
      this.log(`occluders@center opaque=${opaque.length} [${opaque.join(' | ')}]`);
      this.log(`hitstack@center [${stack.slice(0, 6).map((el) => (typeof el.className === 'string' ? el.className.slice(0, 40) : el.tagName)).join(' > ')}]`);
    } catch (err) {
      this.log(`occluder@center probe failed: ${String(err)}`);
    }

    // Style sheet + layer rects sanity.
    try {
      const styleEl = document.getElementById('vibe-terminal-style') as HTMLStyleElement | null;
      const rules = styleEl?.sheet ? styleEl.sheet.cssRules.length : -1;
      this.log(`style ${styleEl ? `present rules=${rules}` : 'MISSING'}`);
      const rr = this.root?.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      const media = this.root?.querySelector('video, iframe');
      const mr = media?.getBoundingClientRect();
      this.log(
        `rects root=${rr ? `${Math.round(rr.width)}x${Math.round(rr.height)}` : 'n/a'} host=${Math.round(hr.width)}x${Math.round(hr.height)} media=${mr ? `${Math.round(mr.width)}x${Math.round(mr.height)}@${Math.round(mr.left - hr.left)},${Math.round(mr.top - hr.top)}` : 'n/a'}`,
      );
    } catch (err) {
      this.log(`rect probe failed: ${String(err)}`);
    }

    // renderer + background alpha probe
    const canvases = Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'));
    this.log(`diag canvas count=${canvases.length}`);
    canvases.forEach((c, i) => {
      let ctxKind = 'unknown';
      let alpha = -1;
      let rgb = '';
      try {
        const ctx2d = c.getContext('2d');
        if (ctx2d) {
          ctxKind = '2d';
          const d = ctx2d.getImageData(Math.max(0, (c.width / 2) | 0), Math.max(0, (c.height / 2) | 0), 1, 1).data;
          alpha = d[3] ?? -1;
          rgb = `${d[0]},${d[1]},${d[2]}`;
        } else {
          const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
          if (gl) {
            ctxKind = 'webgl';
            const px = new Uint8Array(4);
            gl.readPixels((c.width / 2) | 0, (c.height / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            alpha = px[3] ?? -1;
            rgb = `${px[0]},${px[1]},${px[2]}`;
          }
        }
      } catch (err) {
        ctxKind = `err:${String(err)}`;
      }
      this.log(`diag canvas[${i}] ${c.width}x${c.height} ctx=${ctxKind} centerA=${alpha} rgb=${rgb} cls=${c.className || '-'}`);
    });

    // stacking probe: does the xterm element sit above our bg root?
    if (this.root) {
      const rect = this.root.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const before = document.elementFromPoint(cx, cy);
      this.root.style.pointerEvents = 'auto';
      const after = document.elementFromPoint(cx, cy);
      this.root.style.pointerEvents = '';
      const describe = (el: Element | null): string =>
        el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}` : '<none>';
      // rootTop=true → bg layer sits ON TOP of terminal text (bad for readability)
      const rootTop = after === this.root;
      this.log(
        `diag stacking hit(ignore)=${describe(before)} hit(root)=${describe(after)} rootTop=${rootTop ? 'YES-BAD' : 'no (text above bg)'}`,
      );
      const rows = document.querySelectorAll('.xterm-rows').length;
      this.log(`diag renderer rows=${rows} canvas=${document.querySelectorAll('canvas').length}`);
    }
  }
}

// ---- bootstrap -----------------------------------------------------------

declare global {
  interface Window {
    __vibeTerminalRuntime?: boolean;
  }
}

function bootstrap(): void {
  if (window.__vibeTerminalRuntime) return;
  window.__vibeTerminalRuntime = true;

  const runtime = new VibeRuntime();

  window.addEventListener('error', (ev) => {
    try {
      void fetch(`http://127.0.0.1:${runtime.bridgePort}/v1/log`, {
        method: 'POST',
        body: `[runtime] window.onerror: ${ev.message}`,
      }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  });

  runtime.start();
}

bootstrap();
