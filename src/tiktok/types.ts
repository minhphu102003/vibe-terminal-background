// TikTok metadata types (spec §7).

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
