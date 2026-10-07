/**
 * PATH resolution, shared by `run` (to diagnose a failed spawn) and `setup`
 * (to alias only the agents the developer actually has installed).
 *
 * Implemented in-process rather than by shelling out to `which`, which would
 * itself depend on the user's shell being configured — the very thing `setup`
 * is in the middle of changing.
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Resolve `command` the way `execvp` would, returning the absolute path or
 * undefined when nothing executable matches.
 */
export function findExecutable(command: string): string | undefined {
  // A command containing a separator is a path, not a PATH lookup.
  if (command.includes('/')) return isExecutableFile(command) ? command : undefined;

  const entries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0);

  for (const entry of entries) {
    const candidate = join(entry, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    // Directories carry the execute bit too (it means "searchable"), so the
    // access check alone would match a directory of the same name.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
