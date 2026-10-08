// pi adapter — ~/.pi/agent/hooks/vibe-state.ts (spec §15.3).
// Hooks load via jiti; each pi.on handler fires a state POST.

import { TS_BLOCK_BEGIN, TS_BLOCK_END } from './common';

export const PI_THINKING_EVENTS = ['agent_start', 'turn_start', 'tool_call'] as const;
export const PI_INTERACTIVE_EVENTS = ['agent_end', 'session_shutdown'] as const;

/** Pure builder for the pi hook module (the file is fully owned by this adapter). */
export function buildPiHook(port: number): string {
  const thinking = PI_THINKING_EVENTS.map((e) => `  pi.on('${e}', async () => send('thinking'));`).join('\n');
  const interactive = PI_INTERACTIVE_EVENTS.map((e) => `  pi.on('${e}', async () => send('interactive'));`).join('\n');
  return `${TS_BLOCK_BEGIN}
type HookState = 'thinking' | 'interactive';

export default function (pi: { on: (event: string, handler: () => Promise<void>) => void }) {
  const send = (state: HookState): void => {
    void fetch('http://127.0.0.1:${port}/v1/state', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ state, harness: 'pi' }),
    }).catch(() => undefined);
  };

${thinking}
${interactive}
}
${TS_BLOCK_END}
`;
}
