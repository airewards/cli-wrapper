/**
 * `airewards setup` — install shell aliases that route AI agents through the proxy.
 *
 * The wrapper only earns while it is actually in front of a command, and asking
 * developers to retype `airewards run claude` forever is not a product. So we
 * append a *managed block* to the user's interactive shell rc file that aliases
 * each detected agent to itself-via-the-proxy:
 *
 * ```sh
 * # >>> airewards >>>
 * alias claude="airewards run claude"
 * # <<< airewards <<<
 * ```
 *
 * Editing someone's dotfile is the most invasive thing this package does, so it
 * is deliberately conservative:
 *
 * - **Delimited and idempotent.** Re-running replaces the block between the
 *   markers and never touches a byte outside it; there is no duplicate-append
 *   failure mode.
 * - **Reversible.** `--remove` deletes the block, and the pristine file is
 *   copied to `<rc>.airewards.bak` before the first edit.
 * - **Previewable.** `--dry-run` prints the exact block and target path and
 *   writes nothing.
 * - **No hijacking.** Only agents actually present on PATH are aliased, so
 *   typing an uninstalled command still yields the shell's own
 *   "command not found" rather than an error from us.
 *
 * The aliases cannot recurse: shell aliases expand only in interactive input,
 * while `airewards run` spawns the target binary straight off PATH (see
 * `run.ts`), never through a shell.
 *
 * ## Claude Code
 *
 * Claude gets a second, deeper install on top of the alias: setup writes a
 * `statusLine` hook into its `settings.json` so Claude renders the ad in its own
 * footer instead of the proxy rewriting its output. `claude-native.ts` owns that
 * edit and applies the same rules — delimited to two keys, backed up, dry-runnable
 * and removable — and `--no-claude-hook` opts out of it entirely.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CLAUDE_COMMAND, installNativeHook, removeNativeHook } from './claude-native.js';
import { CONFIG_FILE, saveApiKey } from './config.js';
import { findExecutable } from './path.js';

const BLOCK_START = '# >>> airewards >>>';
const BLOCK_END = '# <<< airewards <<<';

const BLOCK_NOTICE = '# Managed by `airewards setup`. Re-run it to update, or --remove to undo.';

/**
 * Agents worth proxying. Only the ones found on PATH are aliased, so this list
 * can grow freely without affecting anyone who has not installed them.
 */
const KNOWN_AGENTS: readonly string[] = [
  'claude',
  'cline',
  'codex',
  'aider',
  'gemini',
  'cursor-agent',
  'agent',
  'agy',
  'opencode',
  'goose',
];

/** rc file each supported interactive shell sources on startup. */
const SHELL_RC_FILES: Record<string, string> = {
  zsh: '.zshrc',
  bash: '.bashrc',
};

interface SetupOptions {
  dryRun: boolean;
  remove: boolean;
  /** Shell name (`zsh`/`bash`); defaults to the one in `$SHELL`. */
  shell: string | undefined;
  /** Explicit agent list, bypassing PATH detection. */
  agents: readonly string[] | undefined;
  apiKey: string | undefined;
  /** Whether to also install Claude Code's native `statusLine` hook. */
  claudeHook: boolean;
}

export async function setupCommand(argv: string[]): Promise<number> {
  let options: SetupOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`airewards setup: ${messageOf(error)}\n`);
    return 2;
  }

  if (options.apiKey !== undefined) {
    if (options.dryRun) {
      process.stdout.write(`Would store the API key in ${CONFIG_FILE} (mode 0600).\n`);
    } else {
      saveApiKey(options.apiKey);
      process.stdout.write(`Stored your API key in ${CONFIG_FILE} (mode 0600).\n`);
    }
  }

  const shell = options.shell ?? detectShell();
  const rcFileName = shell === undefined ? undefined : SHELL_RC_FILES[shell];
  if (rcFileName === undefined) {
    const shellLabel = shell === undefined ? '' : ` "${shell}"`;
    const supported = Object.keys(SHELL_RC_FILES).join(', ');
    process.stderr.write(
      lines(
        `airewards setup: unsupported shell${shellLabel}. Supported: ${supported}.`,
        'Add lines like this to your shell config manually:',
        '  alias claude="airewards run claude"',
      ),
    );
    return 1;
  }

  const rcPath = join(rcDirectory(shell), rcFileName);

  return options.remove ? removeBlock(rcPath, options) : installBlock(rcPath, options);
}

/**
 * Directory the shell actually reads its rc file from.
 *
 * zsh honours `$ZDOTDIR` over `$HOME`, which dotfile managers routinely set.
 * Ignoring it would write aliases into a `~/.zshrc` the shell never sources —
 * setup would report success and nothing would work.
 */
function rcDirectory(shell: string | undefined): string {
  const zdotdir = process.env.ZDOTDIR;
  if (shell === 'zsh' && zdotdir !== undefined && zdotdir.length > 0) return zdotdir;
  return homedir();
}

function installBlock(rcPath: string, options: SetupOptions): number {
  const agents = options.agents ?? KNOWN_AGENTS.filter(isOnPath);
  if (agents.length === 0) {
    process.stderr.write(
      lines(
        `airewards setup: none of the known agents are on your PATH (${KNOWN_AGENTS.join(', ')}).`,
        'Install one, or pass --agents <names> to alias them anyway.',
      ),
    );
    return 1;
  }

  const block = renderBlock(agents);
  const current = readFileIfExists(rcPath);
  const next = spliceBlock(current, block);
  // Claude is the one agent monetised natively rather than through the proxy, so
  // the hook is only installed when Claude is actually part of this install.
  const withNativeHook = options.claudeHook && agents.includes(CLAUDE_COMMAND);

  if (options.dryRun) {
    process.stdout.write(
      `Would ${current.includes(BLOCK_START) ? 'update' : 'append'} in ${rcPath}:\n\n${block}\n`,
    );
    if (withNativeHook) process.stdout.write(lines('', ...installNativeHook(true)));
    return 0;
  }

  backupOnce(rcPath);
  writeFileSync(rcPath, next, 'utf8');

  const plural = agents.length === 1 ? '' : 's';
  process.stdout.write(
    lines(
      `Routed ${agents.length} agent${plural} through AIRewards in ${rcPath}:`,
      ...agents.map((agent) => `  ${agent}`),
      '',
      `Run \`source ${rcPath}\` or open a new terminal to activate.`,
    ),
  );

  if (withNativeHook) process.stdout.write(lines('', ...installNativeHook(false)));

  if (!isOnPath('airewards')) {
    process.stderr.write(
      lines(
        '',
        'Warning: `airewards` is not on your PATH, so the aliases will fail.',
        'Install this package globally (`pnpm add -g @airewards/cli-wrapper`) first.',
      ),
    );
  }

  return 0;
}

function removeBlock(rcPath: string, options: SetupOptions): number {
  const current = readFileIfExists(rcPath);

  if (!current.includes(BLOCK_START)) {
    process.stdout.write(`No AIRewards aliases found in ${rcPath}; nothing to remove.\n`);
  } else if (options.dryRun) {
    process.stdout.write(`Would remove the AIRewards alias block from ${rcPath}.\n`);
  } else {
    backupOnce(rcPath);
    writeFileSync(rcPath, stripBlock(current), 'utf8');
    process.stdout.write(
      lines(
        `Removed the AIRewards alias block from ${rcPath}.`,
        `Run \`source ${rcPath}\` or open a new terminal to deactivate.`,
      ),
    );
  }

  // Attempted regardless of the alias block: the native hook is installed
  // separately, so `--remove` has to undo it even if the rc file was already
  // clean (hand-edited, or a different shell than the one setup wrote to).
  if (options.claudeHook) {
    process.stdout.write(lines('', ...removeNativeHook(options.dryRun)));
  }

  return 0;
}

function renderBlock(agents: readonly string[]): string {
  const aliases = agents.map((agent) => `alias ${agent}="airewards run ${agent}"`);
  return [BLOCK_START, BLOCK_NOTICE, ...aliases, BLOCK_END].join('\n');
}

/**
 * Replace the managed block in `content`, or append it when absent. Everything
 * outside the markers is preserved byte for byte.
 */
function spliceBlock(content: string, block: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);

  if (start !== -1 && end > start) {
    return `${content.slice(0, start)}${block}${content.slice(end + BLOCK_END.length)}`;
  }

  // A partial block (one marker only) means the file was hand-edited; treat it
  // as absent and append rather than guessing at the intended boundaries.
  const separator =
    content.length === 0 || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${block}\n`;
}

function stripBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end <= start) return content;

  const after = content.slice(end + BLOCK_END.length);
  // Drop the newline the block owned so removal leaves no blank gap.
  return `${content.slice(0, start)}${after.startsWith('\n') ? after.slice(1) : after}`;
}

/**
 * Preserve the untouched original the first time we edit. Only written once:
 * a second run must not overwrite the backup with an already-modified file.
 */
function backupOnce(rcPath: string): void {
  if (!existsSync(rcPath) || existsSync(`${rcPath}.airewards.bak`)) return;
  copyFileSync(rcPath, `${rcPath}.airewards.bak`);
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Shell name from `$SHELL` (e.g. `/bin/zsh` → `zsh`). */
function detectShell(): string | undefined {
  const shellPath = process.env.SHELL;
  return shellPath === undefined || shellPath.length === 0 ? undefined : basename(shellPath);
}

function isOnPath(command: string): boolean {
  return findExecutable(command) !== undefined;
}

function parseArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {
    dryRun: false,
    remove: false,
    shell: undefined,
    agents: undefined,
    apiKey: undefined,
    claudeHook: true,
  };

  let index = 0;
  /** Consume the argument after the current flag, advancing past it. */
  const takeValue = (flag: string): string => {
    index += 1;
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };

  while (index < argv.length) {
    const arg = argv[index];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--remove':
        options.remove = true;
        break;
      case '--no-claude-hook':
        options.claudeHook = false;
        break;
      case '--shell':
        options.shell = takeValue('--shell');
        break;
      case '--api-key':
        options.apiKey = takeValue('--api-key');
        break;
      case '--agents':
        options.agents = takeValue('--agents')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        break;
      default:
        throw new Error(`unknown option "${arg}"`);
    }
    index += 1;
  }

  return options;
}

/** Join message lines into one newline-terminated block for a single write. */
function lines(...parts: string[]): string {
  return `${parts.join('\n')}\n`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
