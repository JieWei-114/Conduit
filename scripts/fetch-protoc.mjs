/**
 * Download a platform-matched protoc into vendor/protoc so electron-builder can
 * bundle it (extraResources). Skips if already present. Runs automatically
 * before `pnpm dist` (predist) and can be run manually: `pnpm run fetch:protoc`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '28.3';
const DEST = 'vendor/protoc';

if (fs.existsSync(path.join(DEST, 'bin', 'protoc'))) {
  console.log('✓ vendor/protoc already present');
  process.exit(0);
}

const osKey = { darwin: 'osx', linux: 'linux' }[process.platform];
const archKey = { arm64: 'aarch_64', x64: 'x86_64' }[process.arch];
if (!osKey || !archKey) {
  console.error(`Unsupported platform ${process.platform}/${process.arch} — download protoc manually into ${DEST}`);
  process.exit(1);
}

const asset = `protoc-${VERSION}-${osKey}-${archKey}.zip`;
const url = `https://github.com/protocolbuffers/protobuf/releases/download/v${VERSION}/${asset}`;
const zip = path.join(os.tmpdir(), asset);

console.log(`↓ ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
fs.mkdirSync(DEST, { recursive: true });
execFileSync('unzip', ['-oq', zip, '-d', DEST], { stdio: 'inherit' });
fs.rmSync(zip, { force: true });
console.log(`✓ protoc ${VERSION} → ${DEST}`);
