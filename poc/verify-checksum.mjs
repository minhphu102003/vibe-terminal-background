// Phase 1 PoC helper: verify how product.json checksums are computed.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const appRoot = process.argv[2];
if (!appRoot) {
  console.error('usage: node verify-checksum.mjs <resources/app dir>');
  process.exit(2);
}

const pj = JSON.parse(readFileSync(join(appRoot, 'product.json'), 'utf8'));
const outDir = join(appRoot, 'out');
let ok = 0;
let bad = 0;

for (const [rel, stored] of Object.entries(pj.checksums || {})) {
  try {
    const buf = readFileSync(join(outDir, rel));
    const sha = createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
    const match = sha === stored;
    match ? ok++ : bad++;
    if (!match) console.log(`MISMATCH ${rel}\n  computed ${sha}\n  stored   ${stored}`);
  } catch (e) {
    bad++;
    console.log(`MISSING  ${rel}: ${e.message}`);
  }
}
console.log(`checksums: ${ok} match, ${bad} mismatch/missing`);
console.log(`algorithm: base64(sha256(file-bytes)) with padding stripped`);
