// Marker block + CSP transforms for the workbench HTML patch.
// Pure functions (no fs) — unit testable (spec §3, §4, §15.2).

export const MARKER_BEGIN = '<!--VIBE-TERMINAL:BEGIN-->';
export const MARKER_END = '<!--VIBE-TERMINAL:end-->';

const RUNTIME_FILE = 'vibe-terminal-runtime.js';
const CONFIG_ELEMENT_ID = 'vibe-terminal-config';

export interface PatchInput {
  /** Runtime config embedded for the injected script. */
  config: unknown;
  /** Bridge port to allow in CSP connect-src / media-src. */
  bridgePort: number;
}

function escapeJsonForScriptTag(json: string): string {
  // Prevent "</script>" (or "<!--") inside JSON from breaking out of the tag.
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Split a CSP header into directives (name + source tokens). */
function cspDirectives(csp: string): Array<{ name: string; tokens: string[] }> {
  return csp
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((raw) => {
      const tokens = raw.split(/\s+/);
      const name = (tokens.shift() || '').toLowerCase();
      return { name, tokens };
    });
}

function joinCsp(directives: Array<{ name: string; tokens: string[] }>): string {
  return directives.map((d) => [d.name, ...d.tokens].join(' ')).join('; ') + ';';
}

/** Idempotently add sources to directives of a CSP string. */
export function addCspSources(csp: string, additions: Record<string, string[]>): string {
  const directives = cspDirectives(csp);
  for (const [name, sources] of Object.entries(additions)) {
    const existing = directives.find((d) => d.name === name);
    if (!existing) {
      directives.push({ name, tokens: [...sources] });
      continue;
    }
    const have = new Set(existing.tokens.map((t) => t.toLowerCase()));
    for (const src of sources) {
      if (!have.has(src.toLowerCase())) existing.tokens.push(src);
    }
  }
  return joinCsp(directives);
}

/** Remove exact sources from directives (used by stripPatch when no backup exists). */
export function removeCspSources(csp: string, removals: Record<string, string[]>): string {
  const directives = cspDirectives(csp);
  for (const [name, sources] of Object.entries(removals)) {
    const existing = directives.find((d) => d.name === name);
    if (!existing) continue;
    const drop = new Set(sources.map((s) => s.toLowerCase()));
    existing.tokens = existing.tokens.filter((t) => !drop.has(t.toLowerCase()));
  }
  return joinCsp(directives);
}

export function cspAdditionsFor(bridgePort: number): Record<string, string[]> {
  const bridge = `http://127.0.0.1:${bridgePort}`;
  return {
    'frame-src': ['https://www.tiktok.com'],
    'connect-src': [bridge],
    'media-src': [bridge],
  };
}

/** Patch the CSP meta tag in place (returns null when no CSP meta found). */
export function patchCspMeta(html: string, bridgePort: number): string | null {
  const metaRe = /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i;
  const metaMatch = metaRe.exec(html);
  if (!metaMatch) return null;
  const meta = metaMatch[0];
  // Same-quote backreference: CSP content contains single quotes ('self'),
  // so a plain ["'] terminator would truncate the capture.
  const contentRe = /content\s*=\s*(["'])([\s\S]*?)\1/i;
  const contentMatch = contentRe.exec(meta);
  if (!contentMatch || contentMatch[2] === undefined) return null;
  const content = contentMatch[2];
  const patchedContent = addCspSources(content, cspAdditionsFor(bridgePort));
  if (patchedContent === content) return html;
  const patchedMeta = meta.replace(contentRe, (_m, _q) => `content="${patchedContent.replace(/"/g, '&quot;')}"`);
  return html.replace(meta, patchedMeta);
}

/** Remove our CSP additions (best effort for no-backup recovery). */
export function unpatchCspMeta(html: string, bridgePort: number): string {
  const metaRe = /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i;
  const metaMatch = metaRe.exec(html);
  if (!metaMatch) return html;
  const meta = metaMatch[0];
  const contentRe = /content\s*=\s*(["'])([\s\S]*?)\1/i;
  const contentMatch = contentRe.exec(meta);
  if (!contentMatch || contentMatch[2] === undefined) return html;
  const stripped = removeCspSources(contentMatch[2], cspAdditionsFor(bridgePort));
  const newMeta = meta.replace(contentRe, () => `content="${stripped.replace(/"/g, '&quot;')}"`);
  return html.replace(meta, newMeta);
}

/** Build the marker-delimited injection block. */
export function buildBlock(input: PatchInput): string {
  const json = escapeJsonForScriptTag(JSON.stringify(input.config));
  return [
    MARKER_BEGIN,
    `<script type="application/json" id="${CONFIG_ELEMENT_ID}">${json}</script>`,
    `<script src="./${RUNTIME_FILE}"></script>`,
    MARKER_END,
  ].join('\n\t');
}

/** Insert or replace the marker block. Returns null when structure is unexpected. */
export function insertBlock(html: string, block: string): string | null {
  if (hasBlock(html)) {
    const blockRe = new RegExp(`${escapeRe(MARKER_BEGIN)}[\\s\\S]*?${escapeRe(MARKER_END)}`, 'g');
    return html.replace(blockRe, block);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `\t${block}\n</body>`);
  }
  if (html.includes('</html>')) {
    return html.replace('</html>', `\t${block}\n</html>`);
  }
  return null;
}

/** Remove the marker block entirely. */
export function removeBlock(html: string): string {
  const blockRe = new RegExp(`\\s*${escapeRe(MARKER_BEGIN)}[\\s\\S]*?${escapeRe(MARKER_END)}`, 'g');
  return html.replace(blockRe, '');
}

export function hasBlock(html: string): boolean {
  return html.includes(MARKER_BEGIN) && html.includes(MARKER_END);
}

/** Full patch: CSP + marker block. Returns null on structural failure. */
export function applyPatch(html: string, input: PatchInput): string | null {
  const withCsp = patchCspMeta(html, input.bridgePort);
  if (withCsp === null) return null;
  return insertBlock(withCsp, buildBlock(input));
}

/** Best-effort reverse patch when no backup file exists. */
export function stripPatch(html: string, bridgePort: number): string {
  return unpatchCspMeta(removeBlock(html), bridgePort);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
