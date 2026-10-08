// ISOLATED workaround module (spec §3): the ONLY code allowed to touch
// VS Code install files. Handles locate / backup / patch / restore /
// product.json checksum maintenance for the workbench HTML shell.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatch, stripPatch, hasBlock } from './manifest';

const BACKUP_SUFFIX = '.vibe-terminal.bak';
const RUNTIME_TARGET = 'vibe-terminal-runtime.js';

const HTML_CANDIDATES = [
  // current layout (VS Code ~1.9x+)
  ['resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'],
  // legacy layout
  ['resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.html'],
];

export interface WorkbenchPaths {
  /** Absolute path of the workbench HTML shell. */
  htmlPath: string;
  /** resources/app (holds product.json). */
  appRoot: string;
  /** .../out — product.json checksum keys are relative to this. */
  outRoot: string;
}

export type PatchStatus = 'applied' | 'already' | 'restored' | 'failed';

export interface PatchResult {
  status: PatchStatus;
  /** True when the window must be reloaded for the change to take effect. */
  needsReload: boolean;
  message?: string;
  htmlPath?: string;
}

function shaB64(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function findInstallRoots(): string[] {
  const roots: string[] = [];
  const locals = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']];
  for (const base of locals) {
    if (!base) continue;
    const parent = join(base, 'Programs');
    for (const p of [parent, base]) {
      const candidates = [join(p, 'Microsoft VS Code'), join(p, 'Code', 'Microsoft VS Code')];
      for (const c of candidates) if (existsSync(c)) roots.push(c);
    }
  }
  return [...new Set(roots)];
}

/** Locate workbench.html across install layouts (hash-named update dirs, legacy). */
export function locateWorkbench(): WorkbenchPaths | null {
  for (const root of findInstallRoots()) {
    // root may hold payload directly or inside a hash-named update directory
    let subdirs: string[] = [''];
    try {
      subdirs = ['', ...readdirSync(root).filter((e) => !e.includes('.') && e !== 'bin')];
    } catch {
      /* ignore */
    }
    for (const sub of subdirs) {
      const base = sub ? join(root, sub) : root;
      for (const parts of HTML_CANDIDATES) {
        const htmlPath = join(base, ...parts);
        if (existsSync(htmlPath)) {
          const appRoot = join(base, 'resources', 'app');
          return { htmlPath, appRoot, outRoot: join(appRoot, 'out') };
        }
      }
    }
  }
  return null;
}

export interface PatcherOptions {
  /** Bundled injected runtime (dist/injected/runtime.js) copied into the install dir. */
  runtimeSourcePath: string;
}

export class WorkbenchPatcher {
  constructor(
    private readonly paths: WorkbenchPaths,
    private readonly opts: PatcherOptions,
  ) {}

  private get backupPath(): string {
    return this.paths.htmlPath + BACKUP_SUFFIX;
  }

  private get runtimeTargetPath(): string {
    return join(dirname(this.paths.htmlPath), RUNTIME_TARGET);
  }

  isPatched(): boolean {
    try {
      return hasBlock(readFileSync(this.paths.htmlPath, 'utf8'));
    } catch {
      return false;
    }
  }

  private updateChecksum(content: Buffer): void {
    const pjPath = join(this.paths.appRoot, 'product.json');
    if (!existsSync(pjPath)) return;
    try {
      const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
      if (!pj.checksums) return;
      const rel = relative(this.paths.outRoot, this.paths.htmlPath).split(sep).join('/');
      if (typeof pj.checksums[rel] === 'string') {
        pj.checksums[rel] = shaB64(content);
        writeFileSync(pjPath, JSON.stringify(pj, null, '\t') + '\n', 'utf8');
      }
    } catch (err) {
      // Corrupt product.json would break VS Code — never leave it half-written.
      console.error('[vibe-terminal] product.json checksum update failed', err);
    }
  }

  private ensureBackup(currentHtml: string): void {
    if (existsSync(this.backupPath)) {
      // A missing block means VS Code updated the file: refresh the backup
      // to the pristine new-version content.
      if (!hasBlock(currentHtml)) {
        writeFileSync(this.backupPath, currentHtml, 'utf8');
      }
      return;
    }
    const pristine = hasBlock(currentHtml) ? stripPatch(currentHtml, 0) : currentHtml;
    writeFileSync(this.backupPath, pristine, 'utf8');
  }

  /**
   * Apply (or refresh) the patch. Idempotent: unchanged content is not rewritten.
   * `config` is embedded for runtime bootstrap; `bridgePort` drives CSP additions.
   */
  patch(config: unknown, bridgePort: number): PatchResult {
    let html: string;
    try {
      html = readFileSync(this.paths.htmlPath, 'utf8');
    } catch (err) {
      return { status: 'failed', needsReload: false, message: `Cannot read ${this.paths.htmlPath}: ${errText(err)}` };
    }

    try {
      this.ensureBackup(html);
      const desired = applyPatch(html, { config, bridgePort });
      if (desired === null) {
        return {
          status: 'failed',
          needsReload: false,
          message: 'No Content-Security-Policy meta tag found in the workbench HTML — unsupported VS Code build.',
        };
      }

      const htmlChanged = desired !== html;
      if (htmlChanged) {
        const buf = Buffer.from(desired, 'utf8');
        writeFileSync(this.paths.htmlPath, buf, 'utf8');
        this.updateChecksum(buf);
      }

      // Runtime file may be missing or stale (extension rebuilt since last patch).
      let runtimeCopied = false;
      const sourceBuf = existsSync(this.opts.runtimeSourcePath) ? readFileSync(this.opts.runtimeSourcePath) : null;
      if (!sourceBuf) {
        return {
          status: 'failed',
          needsReload: false,
          message: `Injected runtime bundle missing: ${this.opts.runtimeSourcePath}`,
          htmlPath: this.paths.htmlPath,
        };
      }
      let targetBuf: Buffer | null = null;
      try {
        targetBuf = readFileSync(this.runtimeTargetPath);
      } catch {
        targetBuf = null;
      }
      if (!targetBuf || !targetBuf.equals(sourceBuf)) {
        writeFileSync(this.runtimeTargetPath, sourceBuf);
        runtimeCopied = true;
      }

      return {
        status: htmlChanged ? 'applied' : 'already',
        needsReload: htmlChanged || runtimeCopied,
        htmlPath: this.paths.htmlPath,
      };
    } catch (err) {
      const permission = /EACCES|EPERM|access/i.test(String(err));
      return {
        status: 'failed',
        needsReload: false,
        message: permission
          ? 'No permission to patch the VS Code install directory (run VS Code once as administrator, or use a per-user install).'
          : `Patch failed: ${errText(err)}`,
      };
    }
  }

  /** Restore the original HTML (from backup when available, else strip markers). */
  unpatch(): PatchResult {
    try {
      let restored = false;
      if (existsSync(this.backupPath)) {
        const backup = readFileSync(this.backupPath, 'utf8');
        writeFileSync(this.paths.htmlPath, backup, 'utf8');
        this.updateChecksum(Buffer.from(backup, 'utf8'));
        unlinkSync(this.backupPath);
        restored = true;
      } else {
        const current = readFileSync(this.paths.htmlPath, 'utf8');
        if (hasBlock(current)) {
          const stripped = stripPatch(current, 0);
          const buf = Buffer.from(stripped, 'utf8');
          writeFileSync(this.paths.htmlPath, buf, 'utf8');
          this.updateChecksum(buf);
          restored = true;
        }
      }
      if (existsSync(this.runtimeTargetPath)) unlinkSync(this.runtimeTargetPath);
      if (!restored && !existsSync(this.runtimeTargetPath)) {
        return { status: 'restored', needsReload: false, message: 'Nothing to unpatch.' };
      }
      return { status: 'restored', needsReload: restored, htmlPath: this.paths.htmlPath };
    } catch (err) {
      return { status: 'failed', needsReload: false, message: `Unpatch failed: ${errText(err)}` };
    }
  }

  /** Restore from backup then apply a clean patch (§14 "Unpatch / Repair"). */
  repair(config: unknown, bridgePort: number): PatchResult {
    const restored = this.unpatch();
    if (restored.status === 'failed') return restored;
    return this.patch(config, bridgePort);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
