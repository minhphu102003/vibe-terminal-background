// Adapter registry: target paths, install/uninstall, event mapping (spec §15.3-15.4).

import { join } from 'node:path';
import {
  installFile,
  uninstallFile,
  HARNESS_IDS,
  type HarnessId,
  type InstallOutcome,
  type UninstallOutcome,
} from './common';
import { buildClaudeSettings } from './claude';
import { buildCodexConfig, buildCodexHooks, CODEX_LEGACY_NOTE } from './codex';
import { buildOpenCodePlugin } from './opencode';
import { buildPiHook } from './pi';

export interface AdapterIO {
  home: string;
  port: number;
}

interface Target {
  file: string;
  build: (existing: string | null) => string;
}

export function adapterTargets(id: HarnessId, io: AdapterIO): Target[] {
  switch (id) {
    case 'claude':
      return [{ file: join(io.home, '.claude', 'settings.json'), build: (e) => buildClaudeSettings(e, io.port) }];
    case 'codex':
      return [
        { file: join(io.home, '.codex', 'hooks.json'), build: (e) => buildCodexHooks(e, io.port) },
        { file: join(io.home, '.codex', 'config.toml'), build: (e) => buildCodexConfig(e) },
      ];
    case 'opencode':
      return [
        {
          file: join(io.home, '.config', 'opencode', 'plugins', 'vibe-state.ts'),
          build: (e) => {
            if (e !== null && !e.includes('>>> vibe-terminal >>>')) {
              throw new Error('file exists without a vibe-terminal marker — refusing to overwrite');
            }
            return buildOpenCodePlugin(io.port);
          },
        },
      ];
    case 'pi':
      return [
        {
          file: join(io.home, '.pi', 'agent', 'hooks', 'vibe-state.ts'),
          build: (e) => {
            if (e !== null && !e.includes('>>> vibe-terminal >>>')) {
              throw new Error('file exists without a vibe-terminal marker — refusing to overwrite');
            }
            return buildPiHook(io.port);
          },
        },
      ];
    default: {
      const never: never = id;
      throw new Error(`unknown harness: ${String(never)}`);
    }
  }
}

export interface AdapterFileResult {
  file: string;
  status: InstallOutcome['status'] | UninstallOutcome['status'];
  detail?: string;
}

export function installHarness(id: HarnessId, io: AdapterIO): AdapterFileResult[] {
  return adapterTargets(id, io).map((t) => {
    const r = installFile(t.file, t.build);
    return { file: t.file, status: r.status, ...(r.detail ? { detail: r.detail } : {}) };
  });
}

export function uninstallHarness(id: HarnessId, io: AdapterIO): AdapterFileResult[] {
  return adapterTargets(id, io).map((t) => {
    const r = uninstallFile(t.file);
    return { file: t.file, status: r.status, ...(r.detail ? { detail: r.detail } : {}) };
  });
}

/** Event mapping table (spec §15.3) — surfaced in install output and tests. */
export const EVENT_MAP: Record<HarnessId, { thinking: readonly string[]; interactive: readonly string[] }> = {
  claude: {
    thinking: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart'],
    interactive: ['Stop', 'PermissionRequest', 'Notification(permission_prompt|idle_prompt|elicitation_)', 'SessionEnd'],
  },
  codex: {
    thinking: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
    interactive: ['Stop', 'PermissionRequest', 'Interrupt', 'SessionEnd'],
  },
  opencode: {
    thinking: ['message.part.updated', 'tool.execute.before', 'tool.execute.after', 'permission.replied'],
    interactive: ['session.idle', 'permission.asked'],
  },
  pi: {
    thinking: ['agent_start', 'turn_start', 'tool_call'],
    interactive: ['agent_end', 'session_shutdown'],
  },
};

export { CODEX_LEGACY_NOTE };
export { HARNESS_IDS };
export type { HarnessId };
