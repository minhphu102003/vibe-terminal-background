import { build, context } from 'esbuild';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const production = process.argv.includes('--production');

mkdirSync('dist/injected', { recursive: true });

/** Extension host bundle (CommonJS, vscode external). */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** Injected workbench runtime (plain IIFE, browser, zero imports at runtime). */
const runtimeOptions = {
  entryPoints: ['src/injected/runtime.ts'],
  bundle: true,
  outfile: 'dist/injected/runtime.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  minify: production,
  logLevel: 'info',
  // First statement of the bundle: proves the script executed inside the
  // workbench (used by poc/run-dev.mjs; harmless in production).
  banner: {
    js: "try{fetch('http://127.0.0.1:47832/v1/log',{method:'POST',body:'[runtime] probe:script-executed'}).catch(function(){})}catch(e){}",
  },
};

/** Tests -> dist-test/ (run with `node --test dist-test/`). */
const testOptions = {
  entryPoints: ['test/all.test.ts'],
  bundle: true,
  outfile: 'dist-test/all.test.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

async function main() {
  const options = test ? testOptions : extensionOptions;
  const extra = test ? [] : [runtimeOptions];

  if (watch) {
    const ctxs = await Promise.all([options, ...extra].map((o) => context(o)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild watching...');
  } else {
    await Promise.all([options, ...extra].map((o) => build(o)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
