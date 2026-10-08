// Claude Code adapter — ~/.claude/settings.json hooks (spec §15.3).

import { curlPost, pushEventHook, type VibeHookState } from './common';

export const CLAUDE_THINKING_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
] as const;

export const CLAUDE_INTERACTIVE_EVENTS = ['Stop', 'PermissionRequest', 'SessionEnd'] as const;

/** Notification fires for permission/idle/elicitation prompts — matcher narrows it. */
export const CLAUDE_NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt|elicitation_';

/** Pure builder: existing settings content (or null) → settings with our hooks merged. */
export function buildClaudeSettings(existing: string | null, port: number): string {
  let root: Record<string, unknown>;
  if (existing === null || existing.trim() === '') {
    root = {};
  } else {
    const parsed: unknown = JSON.parse(existing); // throws → install fails safely
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json root must be an object');
    }
    root = parsed as Record<string, unknown>;
  }

  const rawHooks = root.hooks;
  const hooks: Record<string, unknown> =
    rawHooks && typeof rawHooks === 'object' && !Array.isArray(rawHooks)
      ? { ...(rawHooks as Record<string, unknown>) }
      : {};

  const eventState = (ev: string): VibeHookState =>
    (CLAUDE_THINKING_EVENTS as readonly string[]).includes(ev) ? 'thinking' : 'interactive';

  for (const ev of [...CLAUDE_THINKING_EVENTS, ...CLAUDE_INTERACTIVE_EVENTS]) {
    pushEventHook(hooks, ev, curlPost(port, eventState(ev), 'claude'));
  }
  pushEventHook(
    hooks,
    'Notification',
    curlPost(port, 'interactive', 'claude'),
    CLAUDE_NOTIFICATION_MATCHER,
  );

  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}
