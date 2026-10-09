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
import { isPerAppVolumeSupported, rampNotifyFade, warmupPerAppVolume, disposePerAppVolume } from './audio/winPerAppVolume';
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

/** Per-app volume fade (the gentle notify) needs Windows Core Audio. Elsewhere
 *  (macOS has no per-app volume API) the notify sound defaults to OFF. */
function isNotifyFadeSupported(): boolean {
  return process.platform === 'win32';
}

function readRawConfig(): Record<string, unknown> {
  const c = vscode.workspace.getConfiguration(SECTION);
  // notifyOnDone defaults ON only where the fade works (Windows); the user can
  // still set it explicitly on any platform.
  const inspect = c.inspect<boolean>('notifyOnDone');
  const explicit = inspect?.globalValue ?? inspect?.workspaceValue ?? inspect?.workspaceFolderValue;
  const notifyOnDone = typeof explicit === 'boolean' ? explicit : isNotifyFadeSupported();
  return {
    enabled: c.get('enabled'),
    playlist: c.get('playlist'),
    fit: c.get('fit'),
    loop: c.get('loop'),
    audio: c.get('audio'),
    transitionMs: c.get('transitionMs'),
    bridgePort: c.get('bridgePort'),
    stateIdleFallbackSec: c.get('stateIdleFallbackSec'),
    idleFreezeSec: c.get('idleFreezeSec'),
    notifyOnDone,
    notifySec: c.get('notifySec'),
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
  // The port this window's bridge ACTUALLY bound (may differ from the configured
  // base when a sibling VS Code instance already holds it). The injected runtime
  // needs the real port for media/SSE; the patched workbench HTML is shared by
  // every window so it only ever embeds the neutral bootstrap below.
  let boundPort = 0;
  const runtimeConfig = () => ({
    ...toRuntimeConfig(config, (id) => metaCache.get(id)),
    bridgePort: boundPort || config.bridgePort,
  });
  // Embedded into the (shared) workbench.html: neutral — no playlist, no port.
  // The real playlist/port reach the runtime over this window's own SSE bridge.
  const bootstrapConfig = () => ({ enabled: false, playlist: [], bridgePort: config.bridgePort });

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
      // Notify fade: agent stopped (thinking -> interactive = asks or done). The
      // injected runtime unmutes the TikTok iframe; here we gently ramp the VS
      // Code app volume 0 -> level so the music fades IN instead of jumping to
      // full. Windows-only (per-app volume); a no-op elsewhere.
      if (emit.state === 'interactive' && config.notifyOnDone && isPerAppVolumeSupported()) {
        void rampNotifyFade(2.5, 1200).then((ran) => {
          if (ran) log('notify fade: VS Code audio ramped in');
        });
      }
    },
  });
  context.subscriptions.push({ dispose: () => machine.dispose() });

  // Pre-load the per-app volume helper (compiles C# ~1-2s) in the background so
  // the FIRST notify fade is instant instead of lagging behind the unmute.
  if (config.notifyOnDone && isPerAppVolumeSupported()) warmupPerAppVolume();

  // Each VS Code window binds its own bridge so 2+ instances stay independent:
  // scan upward from the configured base until a free port is found.
  const PORT_MAX_SPAN = 28; // matches PORT_SPAN in patch/manifest.ts (CSP range)

  for (let i = 0; i <= PORT_MAX_SPAN; i++) {
    const candidate = config.bridgePort + i;
    const s = new StateServer({
      port: candidate,
      onState: (state, harness) => {
        machine.handle({ state: state as VibeState, harness });
      },
      getSnapshot: () => ({ state: machine.state, config: runtimeConfig() }),
      onLog: (line) => log(line),
    });
    s.setMediaResolver((id) => id);
    try {
      boundPort = await s.start();
      server = s;
      log(`state bridge listening on 127.0.0.1:${boundPort}`);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already in use/i.test(msg) && i < PORT_MAX_SPAN) {
        log(`port ${candidate} in use (another VS Code instance?) — trying ${candidate + 1}`);
        continue;
      }
      log(`state bridge not started: ${msg}`);
      server = null;
      void vscode.window.showWarningMessage(`Vibe Terminal: ${msg} Background keeps working with defaults.`);
      break;
    }
  }
  context.subscriptions.push({ dispose: () => void server?.stop() });

  // Publish this window's bound port so the injected runtime can discover it
  // from the status bar DOM (the workbench.html is shared across windows, so
  // the runtime must not trust the port embedded in it).
  const statusItem = vscode.window.createStatusBarItem('vibeTerminal.bridge', vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Vibe Terminal Bridge';
  if (server && boundPort) {
    statusItem.text = `$(pulse) vibe-bridge:${boundPort}`;
    statusItem.tooltip = `Vibe Terminal state bridge — 127.0.0.1:${boundPort} (this window)`;
    statusItem.show();
  }
  context.subscriptions.push(statusItem);

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
  // Per-window isolation: playlist/enabled are written to the WORKSPACE scope
  // (this folder's .vscode/settings.json) so two instances over two folders
  // never overwrite each other. Empty window falls back to Global.
  const configTarget = (): vscode.ConfigurationTarget =>
    vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

  const setPlaylist = async (entries: string[]): Promise<void> => {
    const c = vscode.workspace.getConfiguration(SECTION);
    await c.update('playlist', entries, configTarget());
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
    vscode.commands.registerCommand('vibeTerminal.showPlaylist', async () => {
      if (config.playlist.length === 0) {
        void vscode.window.showInformationMessage('Vibe Terminal: playlist is empty.');
        return;
      }
      // Runtime reports its position to the bridge; it may be stale (another
      // window, or nothing mounted yet) — only mark it if it fits the list.
      const pos = server?.playerPosition ?? null;
      const currentIndex =
        pos && pos.total === config.playlist.length && pos.at > Date.now() - 120_000 ? pos.index : -1;
      const items = config.playlist.map((source, i) => {
        const id = extractTikTokId(source);
        const title = id ? metaCache.get(id)?.title : undefined;
        const isCurrent = i === currentIndex;
        return {
          label: `${isCurrent ? '$(play) ' : ''}${i + 1}/${config.playlist.length}  ${source}`,
          description: isCurrent ? 'now playing' : title ?? (id ? `tiktok:${id}` : 'local'),
          detail: isCurrent ? undefined : source === pos?.source ? 'reported playing (stale?)' : undefined,
          source,
        };
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Vibe Terminal: Playlist',
        placeHolder: currentIndex >= 0 ? 'entry with ▶ is playing now' : 'select an entry',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(trash) Remove from playlist', action: 'remove' as const },
          { label: '$(copy) Copy source', action: 'copy' as const },
          { label: '$(settings-gear) Open in Settings', action: 'settings' as const },
        ],
        { title: `Vibe Terminal: ${picked.source}` },
      );
      if (!action) return;
      if (action.action === 'remove') {
        await setPlaylist(config.playlist.filter((e) => e !== picked.source));
        void vscode.window.setStatusBarMessage('Vibe Terminal: entry removed', 3000);
      } else if (action.action === 'copy') {
        await vscode.env.clipboard.writeText(picked.source);
        void vscode.window.setStatusBarMessage('Vibe Terminal: source copied', 3000);
      } else {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'vibeTerminal.playlist',
        );
      }
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
      await c.update('enabled', next, configTarget());
      void vscode.window.setStatusBarMessage(`Vibe Terminal: background ${next ? 'enabled' : 'disabled'}`, 3000);
    }),
    vscode.commands.registerCommand('vibeTerminal.clearBackground', async () => {
      const c = vscode.workspace.getConfiguration(SECTION);
      await c.update('playlist', [], configTarget());
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
        // CSP embeds the bridge port range — re-patch and prompt for reload.
        const result = patcher.patch(bootstrapConfig(), config.bridgePort);
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
  disposePerAppVolume();
  /* disposables are released via context.subscriptions */
}
