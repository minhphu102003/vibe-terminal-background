// TikTok URL parsing + official player URL construction (pure, spec §5.2, §6).

const FULL_VIDEO_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/\s]+\/video\/(\d{6,25})/i;
const SHORT_V_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/v\/(\d{6,25})/i;
const EMBED_V_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/embed\/v\d*\/(\d{6,25})/i;
const PHOTO_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/\s]+\/photo\/(\d{6,25})/i;

/** Normal TikTok video URL → post ID. Short links (vm.tiktok.com) need network resolution — not MVP. */
export function extractTikTokId(url: string): string | null {
  const u = url.trim();
  for (const re of [FULL_VIDEO_RE, SHORT_V_RE, EMBED_V_RE, PHOTO_RE]) {
    const m = re.exec(u);
    if (m && m[1]) return m[1];
  }
  return null;
}

export function isTikTokUrl(url: string): boolean {
  return extractTikTokId(url) !== null;
}

/** Unresolvable-in-MVP URL shapes are documented, not guessed. */
export function isUnresolvableTikTokShortLink(url: string): boolean {
  return /^https?:\/\/(?:vm|vt)\.tiktok\.com\//i.test(url.trim());
}

export interface PlayerParams {
  /** True → loop=1 (single-entry playlist). */
  loop: boolean;
  /**
   * True → muted=1 (audio never used). False → muted=0: `muted=1` also
   * *prevents* volume changes in the player (TikTok docs), which would make
   * host `unMute` commands no-ops — so stateful/unmuted audio must load muted=0.
   */
  muted: boolean;
}

/** Official TikTok embedded player URL with MVP parameters (spec §6). */
export function buildPlayerUrl(postId: string, params: PlayerParams): string {
  const q = new URLSearchParams({
    autoplay: '1',
    controls: '0',
    progress_bar: '0',
    play_button: '0',
    fullscreen_button: '0',
    volume_control: '0',
    timestamp: '0',
    muted: params.muted ? '1' : '0',
    loop: params.loop ? '1' : '0',
  });
  return `https://www.tiktok.com/player/v1/${postId}?${q.toString()}`;
}
