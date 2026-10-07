#!/usr/bin/env node
/**
 * Make node-pty's `spawn-helper` executable after install.
 *
 * On POSIX, node-pty launches every child through a small helper binary that it
 * ships prebuilt. The prebuilt copy arrives mode `0644`, and node-pty's own
 * postinstall only fixes up Windows artifacts — so unless something restores
 * the execute bit, every `pty.spawn` fails with `posix_spawnp failed` and the
 * wrapper silently falls back to its non-intercepting relay. The ads would
 * never appear, on a machine where nothing looks broken.
 *
 * Deliberately best-effort: a missing addon, a read-only store, an unsupported
 * platform. Any of those is fine — the wrapper degrades on its own — and none
 * of them may fail the developer's `pnpm install`.
 */

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Every place node-pty may have put the helper, prebuilt or locally compiled. */
function candidatePaths(packageDir) {
  return [
    join(packageDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(packageDir, 'build', 'Release', 'spawn-helper'),
    join(packageDir, 'build', 'Debug', 'spawn-helper'),
  ];
}

function main() {
  if (process.platform === 'win32') return;

  let packageDir;
  try {
    packageDir = dirname(dirname(createRequire(import.meta.url).resolve('node-pty')));
  } catch {
    return; // Addon not installed; the wrapper already handles that.
  }

  for (const path of candidatePaths(packageDir)) {
    try {
      if (!existsSync(path)) continue;
      // Skip the chmod when the bit is already set, so a store that hardlinks
      // packages read-only is not written to for nothing.
      if ((statSync(path).mode & 0o111) !== 0) continue;
      chmodSync(path, 0o755);
    } catch {
      // Nothing here is worth interrupting an install for.
    }
  }
}

main();
