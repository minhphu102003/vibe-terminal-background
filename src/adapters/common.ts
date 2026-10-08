// Shared adapter plumbing: curl hook command, marker detection, backup/restore
// (spec §15.3, §15.4 — backup before modify, byte-for-byte restore on uninstall).

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'pi';
export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'opencode', 'pi'];

export type VibeHookState = 'thinking' | 'interactive';

/** Marker for file formats that support comments (TOML/TS). */
export const BLOCK_BEGIN = '# >>> vibe-terminal >>>';
export const BLOCK_END = '# <<< vibe-terminal <<<';
/** TS files use // comment style. */
export const TS_BLOCK_BEGIN = '// >>> vibe-terminal >>>';
export const TS_BLOCK_END = '// <<< vibe-terminal <<<';

/** Our presence inside JSON configs: the bridge endpoint in a hook command. */
export const JSON_MARKER = '/v1/state';

/**
 * Spec §15.3 hook invocation — fast on Windows 10+, 1s hard timeout,
 * exit 0 even when the bridge is down (fail-safe §15.5).
 */
export function curlPost(port: number, state: VibeHookState, harness: HarnessId): string {
  const body = `{\\"state\\":\\"${state}\\",\\"harness\\":\\"${harness}\\"}`;
  return `curl.exe -m 1 -s -o NUL -X POST http://127.0.0.1:${port}/v1/state -H "Content-Type: application/json" -d "${body}"`;
}

export function containsMarker(text: string): boolean {
  return text.includes(JSON_MARKER) || text.includes(BLOCK_BEGIN) || text.includes(TS_BLOCK_BEGIN);
}

export function backupPath(file: string): string {
  return `${file}.vibe-terminal.bak`;
}

export interface InstallOutcome {
  status: 'installed' | 'created' | 'already' | 'failed';
  detail?: string;
}

export interface UninstallOutcome {
  status: 'restored' | 'deleted' | 'nothing' | 'failed';
  detail?: string;
}

/**
 * Backup-then-write install.
 * - existing backup → already installed (never clobber the pristine backup)
 * - existing file containing our marker → already installed (idempotent)
 * - missing file → created (no backup needed; uninstall deletes it)
 * - otherwise → backup original, then write `build(existing)`
 */
export function installFile(file: string, build: (existing: string | null) => string): InstallOutcome {
  try {
    if (existsSync(backupPath(file))) return { status: 'already' };
    const exists = existsSync(file);
    const existing = exists ? readFileSync(file, 'utf8') : null;
    if (existing !== null && containsMarker(existing)) return { status: 'already' };
    const content = build(existing); // throw before any side effect
    mkdirSync(dirname(file), { recursive: true });
    if (exists) copyFileSync(file, backupPath(file));
    writeFileSync(file, content, 'utf8');
    return { status: exists ? 'installed' : 'created' };
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Restore-first uninstall (spec §15.4).
 * - backup exists → copy it back byte-for-byte, drop the backup
 * - no backup + marker present → the file was created by our install → delete it
 * - otherwise → nothing (never guess at files without our marker)
 */
export function uninstallFile(file: string): UninstallOutcome {
  try {
    const bak = backupPath(file);
    if (existsSync(bak)) {
      copyFileSync(bak, file);
      unlinkSync(bak);
      return { status: 'restored' };
    }
    if (!existsSync(file)) return { status: 'nothing' };
    const text = readFileSync(file, 'utf8');
    if (!containsMarker(text)) return { status: 'nothing' };
    unlinkSync(file);
    return { status: 'deleted' };
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Append a JSON hook group for one event unless the same command is already there. */
export function pushEventHook(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  matcher?: string,
): void {
  const list = Array.isArray(hooks[event]) ? (hooks[event] as Record<string, unknown>[]) : [];
  const group: Record<string, unknown> = { hooks: [{ type: 'command', command }] };
  if (matcher !== undefined) group.matcher = matcher;
  const already = list.some((g) => {
    const inner = Array.isArray(g?.hooks) ? (g.hooks as { command?: unknown }[]) : [];
    return inner.some((h) => h?.command === command);
  });
  if (!already) list.push(group);
  hooks[event] = list;
}
