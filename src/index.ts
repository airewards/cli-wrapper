#!/usr/bin/env node
/**
 * `airewards` — universal terminal proxy for CLI AI agents.
 *
 * A standalone Node executable that sits in front of any AI CLI (`claude`,
 * `cline`, `aider`, …) in any terminal — iTerm2, Terminal.app, tmux, an IDE's
 * integrated shell — and monetises the time the agent spends thinking by putting
 * a sponsored line on one row of the screen: a row reserved from the agent where
 * the window can spare it, or the status line the agent parks on where it cannot.
 *
 * ```
 *   airewards setup                 # alias detected agents through the proxy
 *   airewards run claude --help     # or invoke the proxy directly
 * ```
 *
 * Terminal-agnostic by construction: it wraps the *process* rather than
 * integrating with any host editor, so it needs no extension API and no
 * terminal cooperation. The agent is given a pseudo-terminal, which keeps its
 * terminal intact while leaving the proxy able to rewrite what it prints — see
 * `run.ts` for the stream topology and the choice between the two strategies,
 * `reserved-row.ts` and `injector.ts` for the strategies themselves.
 */

import { createRequire } from 'node:module';
import { saveApiKey } from './config.js';
import { installExtensionCommand } from './install-extension.js';
import { runCommand } from './run.js';
import { setupCommand } from './setup.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Prevent unhandled EPIPE crashes when output is piped to commands like `head` or `grep`
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const USAGE = `airewards ${version} — earn while your AI agent thinks.

Usage:
  airewards set-api-key <key>            Save or update your developer API key
  airewards install-extension [options]  Install extension into VS Code, Cursor, Windsurf
  airewards run <command> [args…]        Run <command> through the proxy
  airewards setup [options]              Alias your AI agents through the proxy
  airewards --version                   Print the version

Install Extension options:
  --editor <all|code|cursor|windsurf|codium>  Target a specific editor (default: all)
  --editor-path <path>                        Path to custom editor binary
  --vsix <path>                               Use local .vsix file instead of downloading
  --url <url>                                 Download from custom VSIX URL
  --api-key <key>                             Save developer API key
  --dry-run                                   Print detected editors without installing

Setup options:
  --api-key <key>    Store your developer API key in ~/.airewards/config.json
  --agents <a,b,c>   Alias these commands instead of auto-detecting on PATH
  --shell <zsh|bash> Override shell detection
  --no-claude-hook   Skip Claude Code's native statusLine hook
  --dry-run          Print what would change without writing
  --remove           Remove the managed alias block

Environment:
  AIREWARDS_API_KEY        Overrides the stored API key
  AIREWARDS_API_BASE_URL   Overrides the API origin (for local backends)
  AIREWARDS_VSIX_URL       Overrides the default VSIX package download URL
  AIREWARDS_PTY=0          Relay on inherited descriptors; no interception
  AIREWARDS_RESERVED_ROW=0 Keep your full terminal height; borrow a status line
  CLAUDE_CONFIG_DIR        Where Claude Code's settings.json lives

Claude Code is monetised natively: setup installs a statusLine hook so Claude
renders the sponsored line itself, and "airewards run claude" just relays.

Get a developer API key from the AIRewards dashboard (Profile → Developer
Settings). Without one the proxy still relays your command untouched.
`;

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'set-api-key':
  case 'update-api-key':
  case 'set-key': {
    let key = rest[0];
    if (key === '--api-key') {
      key = rest[1];
    }
    if (!key || key.trim().length === 0) {
      process.stderr.write('Usage: airewards set-api-key "<air_dev_key>"\n');
      process.exitCode = 2;
      break;
    }
    const cleanKey = key.trim().replace(/^["']|["']$/g, '');
    saveApiKey(cleanKey);
    process.stdout.write('✓ Successfully saved developer API key in ~/.airewards/config.json\n');
    process.exitCode = 0;
    break;
  }
  case 'install-extension':
  case 'install':
    process.exitCode = await installExtensionCommand(rest);
    break;
  case 'run':
    await exitWith(await runCommand(rest));
    break;
  case 'setup':
    process.exitCode = await setupCommand(rest);
    break;
  case '--version':
  case '-v':
    process.stdout.write(`${version}\n`);
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(USAGE);
    break;
  default:
    process.stderr.write(`airewards: unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 2;
}

/**
 * Exit with `code` as soon as the proxy's own output has drained.
 *
 * An explicit exit is needed rather than just setting `process.exitCode`: after
 * an aborted request, Node's HTTP client can leave a half-open socket
 * registered with the event loop until the OS connect timeout expires (~10s on
 * macOS). A developer whose network drops packets to the ad server would
 * otherwise watch their shell hang long after their command finished. Draining
 * first is what keeps `process.exit` from truncating buffered output when
 * stdout is a pipe.
 */
async function exitWith(code: number): Promise<void> {
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) {
      resolve();
      return;
    }
    const onDone = () => resolve();
    stream.once('error', onDone);
    stream.write('', () => {
      stream.off('error', onDone);
      resolve();
    });
  });
}
