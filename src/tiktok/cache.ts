// TikTok metadata cache (spec §17): globalStorage/cache/tiktok/<id>.json, TTL 24h.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TikTokMetadata } from './oembed';

interface CacheRecord extends TikTokMetadata {
  resolvedAt: number;
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class TikTokMetadataCache {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): TikTokMetadata | null {
    try {
      const file = join(this.dir, `${id}.json`);
      if (!existsSync(file)) return null;
      const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheRecord>;
      if (
        typeof rec.id !== 'string' ||
        typeof rec.playerUrl !== 'string' ||
        typeof rec.resolvedAt !== 'number' ||
        this.now() - rec.resolvedAt > this.ttlMs
      ) {
        return null;
      }
      const { resolvedAt: _ignored, ...meta } = rec as CacheRecord;
      return meta;
    } catch {
      return null;
    }
  }

  set(meta: TikTokMetadata): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const rec: CacheRecord = { ...meta, resolvedAt: this.now() };
      writeFileSync(join(this.dir, `${meta.id}.json`), JSON.stringify(rec, null, 2), 'utf8');
    } catch {
      /* cache must never break the command flow */
    }
  }
}
