// Codex adapter — ~/.codex/hooks.json + ~/.codex/config.toml (spec §15.3).

import { BLOCK_BEGIN, BLOCK_END, curlPost, pushEventHook } from './common';

export const CODEX_THINKING_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
export const CODEX_INTERACTIVE_EVENTS = ['Stop', 'PermissionRequest', 'Interrupt', 'SessionEnd'] as const;

/** Legacy Codex without hooks: notify fires only agent-turn-complete (interactive). */
export const CODEX_LEGACY_NOTE =
  'Codex legacy fallback: without hooks (notify = agent-turn-complete) only interactive events fire; thinking cannot be detected.';

/** Pure builder: hooks.json content with our event groups merged in. */
export function buildCodexHooks(existing: string | null, port: number): string {
  let root: Record<string, unknown>;
  if (existing === null || existing.trim() === '') {
    root = {};
  } else {
    const parsed: unknown = JSON.parse(existing); // throws → install fails safely
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hooks.json root must be an object');
    }
    root = parsed as Record<string, unknown>;
  }

  const rawHooks = root.hooks;
  const hooks: Record<string, unknown> =
    rawHooks && typeof rawHooks === 'object' && !Array.isArray(rawHooks)
      ? { ...(rawHooks as Record<string, unknown>) }
      : {};

  for (const ev of CODEX_THINKING_EVENTS) pushEventHook(hooks, ev, curlPost(port, 'thinking', 'codex'));
  for (const ev of CODEX_INTERACTIVE_EVENTS) pushEventHook(hooks, ev, curlPost(port, 'interactive', 'codex'));

  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

const FLAG_LINE = 'codex_hooks = true';

/**
 * Pure builder: ensure the hooks feature flag sits inside [features]
 * (marker-delimited so uninstall/strip can find it; backup is the real restore).
 */
export function buildCodexConfig(existing: string | null): string {
  if (existing !== null && existing.includes(BLOCK_BEGIN)) return existing;
  const block = `${BLOCK_BEGIN}\n# Required by older Codex versions; current Codex enables hooks by default.\n${FLAG_LINE}\n${BLOCK_END}`;
  if (existing === null || existing.trim() === '') return `[features]\n${block}\n`;
  if (existing.includes(FLAG_LINE)) return existing; // flag already set — don't duplicate the TOML key
  const featuresHeader = /^[ \t]*\[features\][^\n]*\n/m.exec(existing);
  if (featuresHeader) {
    const at = featuresHeader.index + featuresHeader[0].length;
    return `${existing.slice(0, at)}${block}\n${existing.slice(at)}`;
  }
  return `${existing.trimEnd()}\n\n[features]\n${block}\n`;
}
