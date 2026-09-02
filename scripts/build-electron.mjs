/**
 * Bundle the TS server into dist-electron/server.cjs (CommonJS) so the Electron
 * main process can require() it without tsx. Native module `pulsar-client` is
 * kept external — it's loaded from the (unpacked) node_modules at runtime.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist-electron', { recursive: true });

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-electron/server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['pulsar-client'],
  logLevel: 'info',
});

// electron main sits alongside the bundled server
cpSync('electron/main.cjs', 'dist-electron/main.cjs');

console.log('✓ server bundled → dist-electron/server.cjs');
