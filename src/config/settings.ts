// Pure configuration model for the extension (no vscode imports — unit testable).

import { extractTikTokId, isTikTokUrl } from '../tiktok/parser';

export type FitMode = 'cover' | 'contain' | 'fill';
export type AudioMode = 'stateful' | 'muted' | 'unmuted';
export type VibeState = 'thinking' | 'interactive';

export interface StateVisuals {
  videoOpacity: number;
  overlayOpacity: number;
  textOpacity: number;
}

export interface VibeConfig {
  enabled: boolean;
  playlist: string[];
  fit: FitMode;
  loop: boolean;
  audio: AudioMode;
  transitionMs: number;
  bridgePort: number;
  stateIdleFallbackSec: number;
  /** Freeze (pause) the video after this many seconds of continuous idle
   *  (interactive state with no change). 0 disables the idle-freeze. */
  idleFreezeSec: number;
  states: Record<VibeState, StateVisuals>;
}

export const DEFAULT_CONFIG: VibeConfig = {
  enabled: true,
  playlist: [],
  fit: 'cover',
  loop: true,
  audio: 'stateful',
  transitionMs: 350,
  bridgePort: 47832,
  stateIdleFallbackSec: 300,
  idleFreezeSec: 30,
  states: {
    thinking: { videoOpacity: 0.85, overlayOpacity: 0.1, textOpacity: 0.4 },
    interactive: { videoOpacity: 0.15, overlayOpacity: 0.55, textOpacity: 1.0 },
  },
};

export function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, v));
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function visuals(raw: unknown, fallback: StateVisuals): StateVisuals {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    videoOpacity: clamp01(r.videoOpacity, fallback.videoOpacity),
    overlayOpacity: clamp01(r.overlayOpacity, fallback.overlayOpacity),
    textOpacity: clamp01(r.textOpacity, fallback.textOpacity),
  };
}

function playlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .slice(0, 100);
}

/** Merge an arbitrary raw settings object over defaults with clamping. */
export function mergeConfig(raw: unknown): VibeConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const states = (r.states && typeof r.states === 'object' ? r.states : {}) as Record<string, unknown>;
  return {
    enabled: bool(r.enabled, DEFAULT_CONFIG.enabled),
    playlist: playlist(r.playlist),
    fit: oneOf(r.fit, ['cover', 'contain', 'fill'] as const, DEFAULT_CONFIG.fit),
    loop: bool(r.loop, DEFAULT_CONFIG.loop),
    audio: oneOf(r.audio, ['stateful', 'muted', 'unmuted'] as const, DEFAULT_CONFIG.audio),
    transitionMs: num(r.transitionMs, DEFAULT_CONFIG.transitionMs, 0, 5000),
    bridgePort: num(r.bridgePort, DEFAULT_CONFIG.bridgePort, 1024, 65535),
    stateIdleFallbackSec: num(r.stateIdleFallbackSec, DEFAULT_CONFIG.stateIdleFallbackSec, 10, 86400),
    idleFreezeSec: num(r.idleFreezeSec, DEFAULT_CONFIG.idleFreezeSec, 0, 86400),
    states: {
      thinking: visuals(states.thinking, DEFAULT_CONFIG.states.thinking),
      interactive: visuals(states.interactive, DEFAULT_CONFIG.states.interactive),
    },
  };
}

/** One playlist entry as the injected runtime consumes it. */
export interface RuntimePlaylistEntry {
  /** Original settings value: absolute file path or TikTok video URL. */
  source: string;
  kind: 'local' | 'tiktok';
  /** Extracted TikTok post id (kind === 'tiktok'). */
  tiktokId?: string;
  /** Source aspect ratio from metadata; runtime defaults to 9:16 when absent. */
  width?: number;
  height?: number;
}

/** Config the injected runtime needs (serializable, no extension internals). */
export interface RuntimeConfig {
  enabled: boolean;
  playlist: RuntimePlaylistEntry[];
  fit: FitMode;
  loop: boolean;
  audio: AudioMode;
  transitionMs: number;
  bridgePort: number;
  idleFreezeSec: number;
  states: Record<VibeState, StateVisuals>;
}

/** Optional metadata lookup (id → aspect hint) used to enrich runtime entries. */
export type MetadataLookup = (id: string) => { width?: number; height?: number } | null | undefined;

export function toRuntimeConfig(c: VibeConfig, lookup?: MetadataLookup): RuntimeConfig {
  return {
    enabled: c.enabled,
    playlist: c.playlist.map((source) => {
      const tiktok = isTikTokUrl(source);
      const tiktokId = tiktok ? extractTikTokId(source) ?? undefined : undefined;
      const meta = tiktokId && lookup ? lookup(tiktokId) : null;
      return {
        source,
        kind: tiktok && tiktokId ? 'tiktok' : 'local',
        ...(tiktokId ? { tiktokId } : {}),
        ...(meta?.width ? { width: meta.width } : {}),
        ...(meta?.height ? { height: meta.height } : {}),
      } satisfies RuntimePlaylistEntry;
    }),
    fit: c.fit,
    loop: c.loop,
    audio: c.audio,
    transitionMs: c.transitionMs,
    bridgePort: c.bridgePort,
    idleFreezeSec: c.idleFreezeSec,
    states: c.states,
  };
}
