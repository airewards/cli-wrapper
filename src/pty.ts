/**
 * Optional `node-pty` binding.
 *
 * A pseudo-terminal is what lets the proxy have both halves of the deal it
 * could not previously have: the child still sees a real terminal
 * (`isTTY === true`, raw mode, a window size, job control) *and* every byte it
 * writes passes through this process, where an ad can be woven into it.
 *
 * `node-pty` is a native addon, so it is the one piece of this package that can
 * fail on a machine where everything else works — no prebuild for the platform,
 * a Node ABI mismatch after an upgrade, a stripped container without libstdc++.
 * That failure must be invisible: it is loaded through `createRequire` inside a
 * `try` rather than with a static `import`, because a top-level import that
 * throws takes the whole process down and there is no catching it. Callers that
 * get `undefined` fall back to the inherited-fd relay in `run.ts`.
 *
 * The types below are declared locally instead of imported from `node-pty` on
 * purpose: `tsc --noEmit` then stays green on a checkout where the addon never
 * compiled, and the surface we depend on is small enough to be worth pinning
 * explicitly.
 */

import { createRequire } from 'node:module';

/** Options passed to {@link NodePty.spawn}; a subset of node-pty's `IPtyForkOptions`. */
export interface PtySpawnOptions {
  /** `TERM` value advertised inside the pty. */
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  /** Must be fully defined — node-pty cannot serialise `undefined` values. */
  readonly env: Record<string, string>;
}

/** How a child exited, as reported by node-pty. */
export interface PtyExit {
  readonly exitCode: number;
  /** Signal number when the child was killed, absent or 0 otherwise. */
  readonly signal?: number | undefined;
}

/** The live child; a subset of node-pty's `IPty`. */
export interface PtyProcess {
  readonly pid: number;
  /** Child output, already decoded — node-pty joins UTF-8 sequences split across reads. */
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: PtyExit) => void): unknown;
  /** Write to the child's stdin, i.e. the master side of the pty. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePty {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
}

/**
 * Load `node-pty`, or return undefined when the addon is unavailable on this
 * machine. Never throws.
 */
export function loadPty(): NodePty | undefined {
  try {
    const module = createRequire(import.meta.url)('node-pty') as Partial<NodePty>;
    // A resolvable-but-broken install (a half-built addon exporting nothing)
    // must degrade the same way a missing one does.
    return typeof module.spawn === 'function' ? (module as NodePty) : undefined;
  } catch {
    return undefined;
  }
}
