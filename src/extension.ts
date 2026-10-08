// Composition root for Vibe Terminal Background.
// Phase 2: activation + settings + command registration.
// Phase 3: state bridge (localhost HTTP + SSE) and state machine.
// Phase 4: workbench patch on activation (+ reload prompt).

import * as vscode from 'vscode';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mergeConfig, toRuntimeConfig, type VibeConfig, type VibeState } from './config/settings';
import { StateMachine } from './bridge/stateMachine';
import { StateServer, setAllowedMediaRoots } from './bridge/stateServer';
import { locateWorkbench, WorkbenchPatcher } from './patch/workbenchPatcher';
import { DiagnosticsLog } from './utils/diagnostics';
import { extractTikTokId, isTikTokUrl } from './tiktok/parser';
import { fetchTikTokMetadata } from './tiktok/oembed';
import { TikTokMetadataCache } from './tiktok/cache';
import {
  CODEX_LEGACY_NOTE,
  EVENT_MAP,
  HARNESS_IDS,
  installHarness,
  uninstallHarness,
  type HarnessId,
} from './adapters';

const SECTION = 'vibeTerminal';

function readRawConfig(): Record<string, unknown> {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: c.get('enabled'),
    playlist: c.get('playlist'),
    fit: c.get('fit'),
    loop: c.get('loop'),
    audio: c.get('audio'),
    transitionMs: c.get('transitionMs'),
    bridgePort: c.get('bridgePort'),
    stateIdleFallbackSec: c.get('stateIdleFallbackSec'),
    states: c.get('states'),
  };
}

function isLocalEntry(entry: string): boolean {
  return !/^https?:\/\//i.test(entry);
}

function updateMediaRoots(config: VibeConfig): void {
  const roots = config.playlist.filter(isLocalEntry).map((e) => dirname(e));
  setAllowedMediaRoots(roots);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Vibe Terminal');
  context.subscriptions.push(output);
  const diagnostics = new DiagnosticsLog(join(context.globalStorageUri.fsPath, 'diagnostics.log'));
  const log = (line: string): void => {
    output.appendLine(line);
    diagnostics.append(line);
  };

  log('activating...');

  let config = mergeConfig(readRawConfig());
  updateMediaRoots(config);

  // The webgl/canvas terminal renderer paints an opaque background into a
  // full-size <canvas> above the video — only the DOM renderer lets it show.
  const ensureDomRenderer = async (): Promise<void> => {
    const term = vscode.workspace.getConfiguration('terminal');
    const gpu = term.get<string>('integrated.gpuAcceleration');
    if (gpu === 'off') {
      log('renderer: terminal.integrated.gpuAcceleration=off (DOM renderer)');
      return;
    }
    if (gpu === 'on') {
      const pick = await vscode.window.showWarningMessage(
        'Vibe Terminal: terminal.integrated.gpuAcceleration="on" paints an opaque canvas over the video. Turn it off (DOM renderer) to see the background.',
        'Turn off GPU acceleration',
      );
      if (pick) {
        await term.update('integrated.gpuAcceleration', 'off', vscode.ConfigurationTarget.Global);
        log('renderer: gpuAcceleration set to "off" by user choice');
      }
      return;
    }
    try {
      await term.update('integrated.gpuAcceleration', 'off', vscode.ConfigurationTarget.Global);
      log('renderer: terminal.integrated.gpuAcceleration set to "off" (DOM renderer — required for the video)');
      void vscode.window.showInformationMessage(
        'Vibe Terminal: set terminal.integrated.gpuAcceleration to "off" so the video shows behind the terminal. Reopen your terminal (or reload the window) to apply.',
      );
    } catch (err) {
      log(`renderer: could not set gpuAcceleration=off: ${String(err)}`);
    }
  };
  void ensureDomRenderer();

  const metaCache = new TikTokMetadataCache(join(context.globalStorageUri.fsPath, 'cache', 'tiktok'));
  const runtimeConfig = () => toRuntimeConfig(config, (id) => metaCache.get(id));

  /** Best-effort metadata: cache → oEmbed → null (never blocks the command). */
  const resolveMeta = async (url: string): Promise<void> => {
    const id = extractTikTokId(url);
    if (!id || metaCache.get(id)) return;
    const meta = await fetchTikTokMetadata(url);
    if (meta) {
      metaCache.set(meta);
      log(`metadata resolved: ${meta.title ?? id} (${meta.width ?? '?'}x${meta.height ?? '?'})`);
    }
  };

  let server: StateServer | null = null;

  const machine = new StateMachine({
    idleFallbackSec: config.stateIdleFallbackSec,
    onChange: (emit) => {
      log(`state -> ${emit.state} (${emit.reason}${emit.harness ? `, ${emit.harness}` : ''})`);
      server?.broadcast('state', { state: emit.state, harness: emit.harness, reason: emit.reason });
    },
  });
  context.subscriptions.push({ dispose: () => machine.dispose() });

  server = new StateServer({
    port: config.bridgePort,
    onState: (state, harness) => {
      machine.handle({ state: state as VibeState, harness });
    },
    getSnapshot: () => ({ state: machine.state, config: runtimeConfig() }),
    onLog: (line) => log(line),
  });
  server.setMediaResolver((id) => id);

  try {
    const port = await server.start();
    log(`state bridge listening on 127.0.0.1:${port}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`state bridge not started: ${msg}`);
    server = null;
    void vscode.window.showWarningMessage(`Vibe Terminal: ${msg} Background keeps working with defaults.`);
  }
  context.subscriptions.push({ dispose: () => void server?.stop() });

  // --- workbench patch (isolated module) --------------------------------
  const workbench = locateWorkbench();
  let patcher: WorkbenchPatcher | null = null;
  let reloadOffered = false;

  const offerReload = (reason: string): void => {
    if (reloadOffered) return;
    reloadOffered = true;
    void vscode.window
      .showInformationMessage(`Vibe Terminal: ${reason} Reload the window to activate the terminal background.`, 'Reload')
      .then((choice) => {
        if (choice === 'Reload') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  };

  if (!workbench) {
    log('workbench HTML not found — background disabled (unsupported VS Code layout).');
  } else {
    patcher = new WorkbenchPatcher(workbench, {
      runtimeSourcePath: join(context.extensionPath, 'dist', 'injected', 'runtime.js'),
    });
    const result = patcher.patch(runtimeConfig(), config.bridgePort);
    if (result.status === 'failed') {
      log(`patch failed: ${result.message ?? 'unknown error'}`);
      void vscode.window.showWarningMessage(`Vibe Terminal: ${result.message ?? 'patch failed'}`);
    } else if (result.status === 'applied') {
      log(`workbench patched: ${result.htmlPath ?? ''}`);
      offerReload('the VS Code workbench was patched.');
    } else {
      log('workbench already patched.');
    }
  }

  // --- commands (Phases 2-7) --------------------------------------------
  const setPlaylist = async (entries: string[]): Promise<void> => {
    const c = vscode.workspace.getConfiguration(SECTION);
    await c.update('playlist', entries, vscode.ConfigurationTarget.Global);
  };

  const promptTikTokUrl = async (title: string): Promise<string | null> => {
    const url = await vscode.window.showInputBox({
      title: `Vibe Terminal: ${title}`,
      prompt: 'Paste a TikTok video URL',
      placeHolder: 'https://www.tiktok.com/@user/video/1234567890123456789',
      validateInput: (v) => {
        const t = v.trim();
        if (isTikTokUrl(t)) return null;
        if (/^https?:\/\/(vm|vt)\.tiktok\.com\//i.test(t)) return 'Short links (vm/vt.tiktok.com) are not supported yet';
        return 'Enter a TikTok video URL';
      },
    });
    return url ? url.trim() : null;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeTerminal.setBackground', async () => {
      const uris = await vscode.window.showOpenDialog({
        title: 'Vibe Terminal: Set Background',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { Video: ['mp4', 'webm', 'mov', 'mkv', 'ogg', 'ogv'] },
      });
      const file = uris?.[0]?.fsPath;
      if (!file) return;
      await setPlaylist([file]);
      void vscode.window.setStatusBarMessage('Vibe Terminal: background set', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.setTikTokBackground', async () => {
      const url = await promptTikTokUrl('Set TikTok Background');
      if (!url) return;
      await resolveMeta(url);
      await setPlaylist([url]);
      void vscode.window.setStatusBarMessage('Vibe Terminal: TikTok background set', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.addTikTokToPlaylist', async () => {
      const url = await promptTikTokUrl('Add TikTok to Playlist');
      if (!url) return;
      if (config.playlist.includes(url)) {
        void vscode.window.showInformationMessage('Vibe Terminal: already in the playlist.');
        return;
      }
      await resolveMeta(url);
      await setPlaylist([...config.playlist, url]);
      void vscode.window.setStatusBarMessage(`Vibe Terminal: added (${config.playlist.length + 1} entries)`, 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.removeFromPlaylist', async () => {
      if (config.playlist.length === 0) {
        void vscode.window.showInformationMessage('Vibe Terminal: playlist is empty.');
        return;
      }
      const items = config.playlist.map((source) => {
        const id = extractTikTokId(source);
        const title = id ? metaCache.get(id)?.title : undefined;
        return { label: source, description: title, source };
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Vibe Terminal: Remove from Playlist',
        placeHolder: 'Select an entry to remove',
      });
      if (!picked) return;
      await setPlaylist(config.playlist.filter((e) => e !== picked.source));
      void vscode.window.setStatusBarMessage('Vibe Terminal: entry removed', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.simulateThinking', () => {
      machine.handle({ state: 'thinking', simulated: true });
      void vscode.window.setStatusBarMessage('Vibe Terminal: simulated state = thinking', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.simulateInteractive', () => {
      machine.handle({ state: 'interactive', simulated: true });
      void vscode.window.setStatusBarMessage('Vibe Terminal: simulated state = interactive', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.toggleBackground', async () => {
      const c = vscode.workspace.getConfiguration(SECTION);
      const next = !c.get<boolean>('enabled', true);
      await c.update('enabled', next, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`Vibe Terminal: background ${next ? 'enabled' : 'disabled'}`, 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.clearBackground', async () => {
      const c = vscode.workspace.getConfiguration(SECTION);
      await c.update('playlist', [], vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage('Vibe Terminal: background cleared', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.reloadBackground', () => {
      server?.broadcast('reload', {});
      log('reload broadcast');
      void vscode.window.setStatusBarMessage('Vibe Terminal: background reloaded', 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.unpatch', () => {
      if (!patcher) {
        void vscode.window.showWarningMessage('Vibe Terminal: workbench not located — nothing to unpatch.');
        return;
      }
      const result = patcher.unpatch();
      if (result.status === 'failed') {
        void vscode.window.showWarningMessage(`Vibe Terminal: ${result.message ?? 'unpatch failed'}`);
        return;
      }
      log('workbench restored from backup.');
      if (result.needsReload) offerReload('the VS Code workbench was restored.');
      else void vscode.window.showInformationMessage('Vibe Terminal: workbench patch removed.');
    }),
    vscode.commands.registerCommand('vibeTerminal.installHarnessAdapters', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          ...HARNESS_IDS.map((h) => ({
            label: h,
            description: `thinking: ${EVENT_MAP[h].thinking.length} events, interactive: ${EVENT_MAP[h].interactive.length} events`,
          })),
          { label: 'all', description: 'install every adapter' },
        ],
        { title: 'Vibe Terminal: Install Harness Adapters' },
      );
      if (!picked) return;
      const ids: HarnessId[] = picked.label === 'all' ? [...HARNESS_IDS] : [picked.label as HarnessId];
      const io = { home: homedir(), port: config.bridgePort };
      let failed = 0;
      for (const id of ids) {
        for (const r of installHarness(id, io)) {
          log(`adapter ${id} install: ${r.file} -> ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
          if (r.status === 'failed') failed++;
        }
      }
      const msg =
        failed === 0
          ? `Vibe Terminal: adapters installed (${ids.join(', ')}).`
          : `Vibe Terminal: ${failed} adapter step(s) failed — see the Vibe Terminal output.`;
      void vscode.window.showInformationMessage(ids.includes('codex') ? `${msg} ${CODEX_LEGACY_NOTE}` : msg);
    }),
    vscode.commands.registerCommand('vibeTerminal.uninstallHarnessAdapters', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          ...HARNESS_IDS.map((h) => ({ label: h })),
          { label: 'all', description: 'uninstall every adapter' },
        ],
        { title: 'Vibe Terminal: Uninstall Harness Adapters' },
      );
      if (!picked) return;
      const ids: HarnessId[] = picked.label === 'all' ? [...HARNESS_IDS] : [picked.label as HarnessId];
      const io = { home: homedir(), port: config.bridgePort };
      let failed = 0;
      for (const id of ids) {
        for (const r of uninstallHarness(id, io)) {
          log(`adapter ${id} uninstall: ${r.file} -> ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
          if (r.status === 'failed') failed++;
        }
      }
      const summary =
        failed === 0
          ? `Vibe Terminal: adapters uninstalled (${ids.join(', ')}).`
          : `Vibe Terminal: ${failed} uninstall step(s) failed — see the Vibe Terminal output.`;
      void vscode.window.showInformationMessage(summary);
    }),
  );

  // --- configuration watcher -------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      const next = mergeConfig(readRawConfig());
      const portChanged = next.bridgePort !== config.bridgePort;
      config = next;
      updateMediaRoots(config);
      machine.reconfigure(config.stateIdleFallbackSec);
      server?.broadcast('config', { config: runtimeConfig(), state: machine.state });
      log('configuration updated');

      if (patcher && portChanged) {
        // CSP embeds the bridge port — re-patch and prompt for reload.
        const result = patcher.patch(runtimeConfig(), config.bridgePort);
        if (result.status === 'failed') log(`re-patch failed: ${result.message ?? ''}`);
        else if (result.needsReload) offerReload('the bridge port changed.');
      }
    }),
  );

  // Dev harness only: the integration runner needs an integrated terminal to
  // mount into. folderOpen auto-tasks are permission-gated in current VS Code
  // and do not run in a fresh profile, so create one explicitly instead.
  if (process.env.VIBE_DEV_SMOKE === '1') {
    const term = vscode.window.createTerminal({ name: 'vibe-smoke' });
    term.show(false);
    log('dev smoke terminal created');
  }

  log('ready');
}

export function deactivate(): void {
  /* disposables are released via context.subscriptions */
}
