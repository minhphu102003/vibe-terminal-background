// Runtime-side player management: local <video> and TikTok official iframe,
// playlist rotation, stateful audio (spec §6, §8, §9, §12, §19).

import type { AudioMode, FitMode, RuntimeConfig, RuntimePlaylistEntry, VibeState } from '../config/settings';
import { buildPlayerUrl } from '../tiktok/parser';
import { fitBox } from '../background/dimensions';

const TIKTOK_ORIGIN = 'https://www.tiktok.com';

export function shouldMute(audio: AudioMode, state: VibeState): boolean {
  if (audio === 'muted') return true;
  if (audio === 'unmuted') return false;
  return state === 'interactive';
}

export interface PlayerManagerCallbacks {
  onLog: (msg: string) => void;
  /** Reported on every mount: which playlist entry is on screen right now. */
  onIndex?: (index: number, total: number, source: string) => void;
}

export class PlayerManager {
  private entries: RuntimePlaylistEntry[] = [];
  private index = 0;
  private video: HTMLVideoElement | null = null;
  private iframe: HTMLIFrameElement | null = null;

  private audio: AudioMode = 'stateful';
  private fit: FitMode = 'cover';
  private loop = true;
  private bridgePort = 47832;
  private state: VibeState = 'interactive';
  private containerW = 0;
  private containerH = 0;
  private disposed = false;
  private ready = false;
  // Last play/pause intent from the runtime — respected when TikTok becomes
  // ready (otherwise onPlayerReady would force-play even while hidden).
  private paused = false;
  // Notification (audio alert): unmute for notifySec when the agent stops.
  // Requires the TikTok iframe to load muted=0 (muted=1 locks volume per TikTok
  // docs, making unMute a no-op), which is only safe when notify is enabled.
  private notifyEnabled = false;
  private notifyActive = false;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** True while a notification unmute is in flight (runtime suppresses idle-freeze). */
  get isNotifying(): boolean {
    return this.notifyActive;
  }

  private readonly onMessage = (ev: MessageEvent) => this.handleMessage(ev);

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: PlayerManagerCallbacks,
  ) {
    window.addEventListener('message', this.onMessage);
  }

  configure(cfg: RuntimeConfig): void {
    const playlistChanged = JSON.stringify(cfg.playlist) !== JSON.stringify(this.entries);
    this.audio = cfg.audio;
    this.fit = cfg.fit;
    this.loop = cfg.loop;
    this.bridgePort = cfg.bridgePort;
    this.notifyEnabled = cfg.notifyOnDone;
    if (playlistChanged) {
      this.entries = cfg.playlist;
      this.index = 0;
      this.mount();
    } else {
      this.applyAudio();
    }
  }

  setState(state: VibeState): void {
    this.state = state;
    this.applyAudio();
  }

  resize(width: number, height: number): void {
    this.containerW = width;
    this.containerH = height;
    this.layoutIframe();
  }

  reload(): void {
    this.mount();
  }

  pause(): void {
    this.paused = true;
    if (this.video) this.video.pause();
    // TikTok iframe: postMessage pause (no-op until onPlayerReady → ready).
    if (this.iframe && this.ready) this.post('pause');
  }

  play(): void {
    this.paused = false;
    if (this.video) void this.video.play().catch(() => undefined);
    if (this.iframe && this.ready) this.post('play');
  }

  /** Unmute for durationSec as an audio alert, then restore the state mute. */
  notify(durationSec: number): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.notifyActive = true;
    if (this.iframe && this.ready) {
      this.post('play'); // ensure it is running (idle-freeze may have paused it)
      this.post('unMute');
    } else if (this.video) {
      this.video.muted = false;
      void this.video.play().catch(() => undefined);
    }
    this.cb.onLog(`notify: unmute ${durationSec}s`);
    this.notifyTimer = setTimeout(() => {
      this.notifyActive = false;
      this.applyAudio(); // restore the state-appropriate mute
      this.cb.onLog('notify: done -> mute');
      this.notifyTimer = null;
    }, durationSec * 1000);
    (this.notifyTimer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('message', this.onMessage);
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.teardownElement();
  }

  private currentEntry(): RuntimePlaylistEntry | null {
    if (this.entries.length === 0) return null;
    const i = Math.min(this.index, this.entries.length - 1);
    return this.entries[i] ?? null;
  }

  private next(): void {
    if (this.entries.length <= 1) return;
    this.index = (this.index + 1) % this.entries.length;
    this.cb.onLog(`playlist -> entry ${this.index + 1}/${this.entries.length}`);
    this.mount();
  }

  private teardownElement(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
      this.video = null;
    }
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    this.ready = false;
  }

  private mount(): void {
    if (this.disposed) return;
    this.teardownElement();
    const entry = this.currentEntry();
    if (!entry) return;
    this.cb.onIndex?.(Math.min(this.index, this.entries.length - 1), this.entries.length, entry.source);

    const single = this.entries.length === 1;

    if (entry.kind === 'tiktok' && entry.tiktokId) {
      const iframe = document.createElement('iframe');
      iframe.className = 'vibe-media vibe-media--iframe';
      // Load muted=1 normally (guaranteed autoplay). When notifications are on,
      // load muted=0 so the player's volume is unlocked (muted=1 locks it and
      // makes host unMute commands no-ops) — the runtime mutes right after
      // ready and unmutes only for the notify window.
      iframe.setAttribute('src', buildPlayerUrl(entry.tiktokId, { loop: single && this.loop, muted: !this.notifyEnabled }));
      iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
      iframe.setAttribute('title', 'vibe-terminal-tiktok');
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      this.iframe = iframe;
      this.root.appendChild(iframe);
      this.layoutIframe();
      this.cb.onLog(`tiktok player mounted (${entry.tiktokId})`);
    } else {
      const video = document.createElement('video');
      video.className = 'vibe-media';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.loop = single && this.loop;
      video.src = `http://127.0.0.1:${this.bridgePort}/v1/media/${encodeURIComponent(entry.source)}`;
      video.addEventListener('ended', () => this.next());
      video.addEventListener('error', () => {
        this.cb.onLog(`video error: ${entry.source}`);
      });
      this.video = video;
      this.root.appendChild(video);
      if (!this.paused) void video.play().catch(() => this.cb.onLog('autoplay blocked (will start muted)'));
      this.cb.onLog(`local video mounted (${entry.source})`);
    }

    this.applyAudio();
  }

  private layoutIframe(): void {
    if (!this.iframe) return;
    const entry = this.currentEntry();
    const contentW = entry?.width && entry.width > 0 ? entry.width : 720;
    const contentH = entry?.height && entry.height > 0 ? entry.height : 1280;
    const box = fitBox(this.containerW, this.containerH, contentW, contentH, this.fit);
    this.iframe.style.left = `${Math.round(box.x)}px`;
    this.iframe.style.top = `${Math.round(box.y)}px`;
    this.iframe.style.width = `${Math.round(box.width)}px`;
    this.iframe.style.height = `${Math.round(box.height)}px`;
  }

  private handleMessage(ev: MessageEvent): void {
    if (ev.origin !== TIKTOK_ORIGIN) return;
    if (!this.iframe || ev.source !== this.iframe.contentWindow) return;
    let data: unknown;
    try {
      data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const msg = data as { type?: unknown; value?: unknown };
    if (typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'onPlayerReady':
        this.ready = true;
        this.cb.onLog('tiktok onPlayerReady');
        if (!this.paused) this.post('play');
        this.applyAudio();
        break;
      case 'onStateChange':
        if (msg.value === 0) this.next();
        break;
      case 'onMute':
        this.cb.onLog(`tiktok onMute=${String(msg.value)}`);
        break;
      case 'onVolumeChange':
        this.cb.onLog(`tiktok volume=${String(msg.value)}`);
        break;
      case 'onError':
        this.cb.onLog(`tiktok error=${String(msg.value)}`);
        // 3002 AUTOPLAY_ERROR: browser blocked unmuted autoplay (we loaded
        // muted=0 for notifications). Fall back to a muted=1 load so the video
        // still plays (silently) instead of not at all.
        if (msg.value === 3002 && this.notifyEnabled) {
          this.notifyEnabled = false;
          this.mount();
        }
        break;
      default:
        break;
    }
  }

  private post(command: 'mute' | 'unMute' | 'play' | 'pause'): void {
    if (!this.iframe || !this.iframe.contentWindow) return;
    try {
      // TikTok docs: host->player messages are objects tagged with x-tiktok-player.
      this.iframe.contentWindow.postMessage({ type: command, 'x-tiktok-player': true }, TIKTOK_ORIGIN);
    } catch {
      /* player gone */
    }
  }

  private applyAudio(): void {
    // During a notification we force unmuted; otherwise state decides.
    const mute = this.notifyActive ? false : shouldMute(this.audio, this.state);
    if (this.video) {
      this.video.muted = mute;
      if (!mute) void this.video.play().catch(() => undefined);
    }
    // TikTok: mute via postMessage only when NOT notifying. (Loads are muted=1
    // unless notify is on — muted=1 would make even this mute redundant.)
    if (this.iframe && this.ready && !this.notifyActive) this.post('mute');
  }
}
