// Small capped append-only diagnostics log (support + PoC verification).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 256 * 1024;
const TRIM_TO = 64 * 1024;

export class DiagnosticsLog {
  constructor(private readonly file: string) {}

  append(line: string): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.file, `${new Date().toISOString()} ${line}\n`, 'utf8');
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) {
        const content = readFileSync(this.file, 'utf8');
        writeFileSync(this.file, content.slice(-TRIM_TO), 'utf8');
      }
    } catch {
      /* diagnostics must never break the extension */
    }
  }
}
