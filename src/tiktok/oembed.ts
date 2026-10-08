// TikTok oEmbed metadata resolver (spec §7). Best-effort: never throws —
// playback must not depend on metadata availability.

import { extractTikTokId } from './parser';

export interface TikTokMetadata {
  id: string;
  originalUrl: string;
  title?: string;
  authorName?: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  playerUrl: string;
}

export interface OembedResponse {
  title?: unknown;
  author_name?: unknown;
  width?: unknown;
  height?: unknown;
  thumbnail_url?: unknown;
}

/** Minimal fetch surface so tests can inject a stub. */
export type OembedFetch = (url: string, signal: AbortSignal) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const defaultFetch: OembedFetch = async (url, signal) => {
  const res = await fetch(url, { signal });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
}

/** Normalize an oEmbed payload into TikTokMetadata (id/playerUrl derived locally). */
export function parseOembed(id: string, originalUrl: string, raw: unknown): TikTokMetadata {
  const r = (raw && typeof raw === 'object' ? raw : {}) as OembedResponse;
  return {
    id,
    originalUrl,
    ...(str(r.title) !== undefined ? { title: str(r.title) } : {}),
    ...(str(r.author_name) !== undefined ? { authorName: str(r.author_name) } : {}),
    ...(positiveInt(r.width) !== undefined ? { width: positiveInt(r.width) } : {}),
    ...(positiveInt(r.height) !== undefined ? { height: positiveInt(r.height) } : {}),
    ...(str(r.thumbnail_url) !== undefined ? { thumbnailUrl: str(r.thumbnail_url) } : {}),
    playerUrl: `https://www.tiktok.com/player/v1/${id}`,
  };
}

/**
 * Resolve metadata via TikTok's official oEmbed endpoint.
 * Returns null for non-TikTok URLs, network errors, timeouts, and non-200s.
 */
export async function fetchTikTokMetadata(
  url: string,
  opts: { fetchImpl?: OembedFetch; timeoutMs?: number } = {},
): Promise<TikTokMetadata | null> {
  const id = extractTikTokId(url);
  if (!id) return null;
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await doFetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, controller.signal);
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    return parseOembed(id, url, raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
