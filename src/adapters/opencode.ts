// OpenCode adapter — ~/.config/opencode/plugins/vibe-state.ts (spec §15.3).
// Bus events arrive through the `event` hook; POSTs are fire-and-forget.

import { TS_BLOCK_BEGIN, TS_BLOCK_END } from './common';

export const OPENCODE_THINKING_EVENTS = [
  'message.part.updated',
  'tool.execute.before',
  'tool.execute.after',
  'permission.replied',
] as const;
export const OPENCODE_INTERACTIVE_EVENTS = ['session.idle', 'permission.asked'] as const;

/** Pure builder for the plugin module (the file is fully owned by this adapter). */
export function buildOpenCodePlugin(port: number): string {
  const thinking = OPENCODE_THINKING_EVENTS.map((e) => `'${e}'`).join(', ');
  const interactive = OPENCODE_INTERACTIVE_EVENTS.map((e) => `'${e}'`).join(', ');
  return `${TS_BLOCK_BEGIN}
const THINKING = new Set<string>([${thinking}]);
const INTERACTIVE = new Set<string>([${interactive}]);

export const VibeState = async () => ({
  event: async ({ event }: { event: { type: string } }) => {
    const state = THINKING.has(event.type) ? 'thinking' : INTERACTIVE.has(event.type) ? 'interactive' : null;
    if (state === null) return;
    void fetch('http://127.0.0.1:${port}/v1/state', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ state, harness: 'opencode' }),
    }).catch(() => undefined);
  },
});
${TS_BLOCK_END}
`;
}
