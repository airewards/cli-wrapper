/**
 * `airewards install-extension` — 1-step installer for VS Code, Cursor, Windsurf, and VSCodium.
 *
 * Automatically detects installed editors across macOS, Windows, and Linux by their
 * dedicated application binaries (and $PATH fallbacks), downloads the official
 * AIRewards VSIX extension, and installs it via each editor's `--install-extension` CLI.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_URL, loadConfig, saveApiKey } from './config.js';
import { findExecutable } from './path.js';

export const DEFAULT_VSIX_URL =
  process.env.AIREWARDS_VSIX_URL ?? `${DEFAULT_BASE_URL}/downloads/airewards-vscode-0.1.0.vsix`;

export const FALLBACK_VSIX_URL =
  'https://raw.githubusercontent.com/airewards/airewards/master/apps/web/public/downloads/airewards-vscode-0.1.0.vsix';

const MIN_VSIX_BYTES = 4096;

export interface EditorDefinition {
  name: string;
  bin: string;
  mac: string[];
  win: string[];
  linux: string[];
}

export function editorTable(): Record<string, EditorDefinition> {
  const home = homedir();
  const la = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  return {
    code: {
      name: 'Visual Studio Code',
      bin: 'code',
      mac: [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
      ],
      win: [
        join(la, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
        join(pf, 'Microsoft VS Code', 'bin', 'code.cmd'),
        join(pfx86, 'Microsoft VS Code', 'bin', 'code.cmd'),
      ],
      linux: [
        '/usr/share/code/bin/code',
        '/snap/bin/code',
        '/var/lib/flatpak/exports/bin/com.visualstudio.code',
      ],
    },
    cursor: {
      name: 'Cursor',
      bin: 'cursor',
      mac: [
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
        join(home, 'Applications/Cursor.app/Contents/Resources/app/bin/cursor'),
      ],
      win: [
        join(la, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
        join(la, 'Programs', 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
        join(pf, 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
      ],
      linux: ['/opt/Cursor/cursor', '/snap/bin/cursor'],
    },
    windsurf: {
      name: 'Windsurf',
      bin: 'windsurf',
      mac: [
        '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
        join(home, 'Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'),
      ],
      win: [
        join(la, 'Programs', 'Windsurf', 'bin', 'windsurf.cmd'),
        join(pf, 'Windsurf', 'bin', 'windsurf.cmd'),
      ],
      linux: ['/opt/Windsurf/bin/windsurf', '/snap/bin/windsurf'],
    },
    codium: {
      name: 'VSCodium',
      bin: 'codium',
      mac: [
        '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
        join(home, 'Applications/VSCodium.app/Contents/Resources/app/bin/codium'),
      ],
      win: [
        join(la, 'Programs', 'VSCodium', 'bin', 'codium.cmd'),
        join(pf, 'VSCodium', 'bin', 'codium.cmd'),
      ],
      linux: [
        '/usr/share/codium/bin/codium',
        '/snap/bin/codium',
        '/var/lib/flatpak/exports/bin/com.vscodium.codium',
      ],
    },
  };
}

export interface TargetEditor {
  name: string;
  command: string;
}

export interface InstallOptions {
  editor: 'all' | 'code' | 'cursor' | 'windsurf' | 'codium';
  editorPath?: string;
  vsixPath?: string;
  url: string;
  apiKey?: string;
  dryRun: boolean;
}

export function parseInstallArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = {
    editor: 'all',
    url: DEFAULT_VSIX_URL,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--editor') {
      const val = argv[++i]?.toLowerCase();
      if (!val || !['all', 'code', 'cursor', 'windsurf', 'codium'].includes(val)) {
        throw new Error(
          `--editor must be one of: all, code, cursor, windsurf, codium (got "${val}")`,
        );
      }
      opts.editor = val as InstallOptions['editor'];
    } else if (arg === '--editor-path') {
      opts.editorPath = argv[++i];
      if (!opts.editorPath || opts.editorPath.startsWith('-')) {
        throw new Error('--editor-path requires a command or absolute path to the editor CLI');
      }
    } else if (arg === '--vsix') {
      opts.vsixPath = argv[++i];
      if (!opts.vsixPath || opts.vsixPath.startsWith('-')) {
        throw new Error('--vsix requires a path to a .vsix file');
      }
    } else if (arg === '--url') {
      opts.url = argv[++i];
      if (!opts.url || !/^https?:\/\//i.test(opts.url)) {
        throw new Error('--url must be a valid http or https URL');
      }
    } else if (arg === '--api-key') {
      opts.apiKey = argv[++i];
      if (!opts.apiKey || opts.apiKey.startsWith('-')) {
        throw new Error('--api-key requires a developer API key (air_dev_…)');
      }
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(
        `Unknown argument "${arg}". Run "airewards install-extension --help" for options.`,
      );
    }
  }

  return opts;
}

function printUsage(): void {
  process.stdout.write(`Usage: airewards install-extension [options]

Installs the official AIRewards extension into your coding IDE(s).
Automatically detects VS Code, Cursor, Windsurf, and VSCodium.

Options:
  --editor <all|code|cursor|windsurf|codium>
                      Target a specific editor (default: all detected)
  --editor-path <cmd> Full path to custom editor binary
  --vsix <path>       Use a local .vsix file instead of downloading
  --url <url>         Custom URL to download the .vsix package
  --api-key <key>     Store your developer API key (~/.airewards/config.json)
  --dry-run           Show what would be installed without modifying editors
  -h, --help          Show this help text

Examples:
  npx -y @airewards/cli-wrapper install-extension
  airewards install-extension --editor cursor
  airewards install-extension --api-key air_dev_xxxxxxxx
`);
}

/**
 * Resolve an editor's command path: checks application bundles first (unambiguous),
 * then checks $PATH.
 */
export function resolveEditorCommand(editor: EditorDefinition): string | null {
  const locs =
    process.platform === 'darwin'
      ? editor.mac
      : process.platform === 'win32'
        ? editor.win
        : editor.linux;

  for (const p of locs) {
    if (existsSync(p)) return p;
  }

  // Fallback to searching PATH
  const onPath = findExecutable(editor.bin);
  if (onPath) return onPath;

  return null;
}

function absKey(cmd: string): string {
  try {
    return realpathSync(cmd);
  } catch {
    return cmd;
  }
}

export function resolveTargets(opts: InstallOptions): TargetEditor[] {
  if (opts.editorPath) {
    return [{ name: `Custom (${opts.editorPath})`, command: opts.editorPath }];
  }

  const table = editorTable();
  const keys =
    opts.editor === 'all' ? (Object.keys(table) as Array<keyof typeof table>) : [opts.editor];
  const targets: TargetEditor[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const entry = table[key];
    if (!entry) continue;
    const command = resolveEditorCommand(entry);
    if (!command) continue;

    const dedupe = absKey(command);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    targets.push({ name: entry.name, command });
  }

  return targets;
}

/**
 * Find or fetch the VSIX file.
 */
export async function acquireVsix(opts: InstallOptions): Promise<string> {
  // 1. Specified local file
  if (opts.vsixPath) {
    if (!existsSync(opts.vsixPath)) {
      throw new Error(`Specified VSIX file not found: ${opts.vsixPath}`);
    }
    return opts.vsixPath;
  }

  // 2. Check bundled assets inside package
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidateBundledPaths = [
    join(currentDir, '..', 'assets', 'airewards-vscode.vsix'),
    join(currentDir, 'assets', 'airewards-vscode.vsix'),
    // Check repository workspace location when running in dev/monorepo
    join(currentDir, '..', '..', 'web', 'public', 'downloads', 'airewards-vscode-0.1.0.vsix'),
    join(
      currentDir,
      '..',
      '..',
      '..',
      'apps',
      'web',
      'public',
      'downloads',
      'airewards-vscode-0.1.0.vsix',
    ),
  ];

  for (const candidate of candidateBundledPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 3. Download via fetch
  process.stdout.write(`Downloading AIRewards VSIX from ${opts.url}…\n`);
  let bytes: Buffer | null = null;

  try {
    const res = await fetch(opts.url);
    if (res.ok) {
      bytes = Buffer.from(await res.arrayBuffer());
    }
  } catch {
    // Retry with fallback URL if primary fails
  }

  if (!bytes || bytes.length < MIN_VSIX_BYTES) {
    if (opts.url !== FALLBACK_VSIX_URL) {
      process.stdout.write(`Primary download failed, trying fallback (${FALLBACK_VSIX_URL})…\n`);
      const fallbackRes = await fetch(FALLBACK_VSIX_URL);
      if (fallbackRes.ok) {
        bytes = Buffer.from(await fallbackRes.arrayBuffer());
      }
    }
  }

  if (!bytes || bytes.length < MIN_VSIX_BYTES) {
    throw new Error(
      `Could not download AIRewards VSIX (received ${bytes ? bytes.length : 0} bytes).\nCheck your network connection or specify a local file with --vsix <path>.`,
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'airewards-vsix-'));
  const tempPath = join(tempDir, 'airewards-vscode.vsix');
  writeFileSync(tempPath, bytes, { mode: 0o600 });
  return tempPath;
}

/**
 * Main handler for `airewards install-extension`.
 */
export async function installExtensionCommand(argv: string[]): Promise<number> {
  let opts: InstallOptions;
  try {
    opts = parseInstallArgs(argv);
  } catch (err) {
    process.stderr.write(
      `airewards install-extension: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  if (opts.apiKey) {
    saveApiKey(opts.apiKey);
    process.stdout.write('✓ Saved developer API key to ~/.airewards/config.json\n');
  }

  const targets = resolveTargets(opts);

  if (opts.dryRun) {
    process.stdout.write(`[dry-run] Target mode: ${opts.editor}\n`);
    if (targets.length === 0) {
      process.stdout.write('[dry-run] No compatible editors detected on this machine.\n');
    } else {
      process.stdout.write(`[dry-run] Detected ${targets.length} editor(s):\n`);
      for (const t of targets) {
        process.stdout.write(`  - ${t.name}: ${t.command} --install-extension <vsix> --force\n`);
      }
    }
    return 0;
  }

  if (targets.length === 0) {
    process.stderr.write(
      '\x1b[31mNo supported editors detected\x1b[0m (VS Code, Cursor, Windsurf, or VSCodium).\n\n' +
        'If your editor is installed in a custom location, specify it directly:\n' +
        '  airewards install-extension --editor-path /path/to/editor-cli\n\n' +
        'Or install the command in your PATH:\n' +
        `  In VS Code/Cursor: Press Cmd+Shift+P (or Ctrl+Shift+P) -> "Shell Command: Install 'code'/'cursor' command in PATH".\n`,
    );
    return 1;
  }

  let vsixPath: string;
  try {
    vsixPath = await acquireVsix(opts);
  } catch (err) {
    process.stderr.write(
      `\x1b[31mError acquiring VSIX package:\x1b[0m ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n\x1b[1mAIRewards IDE Extension Installer\x1b[0m\nDetected ${targets.length} editor(s): ${targets.map((t) => t.name).join(', ')}\n\n`,
  );

  let successCount = 0;
  const failures: string[] = [];

  for (const target of targets) {
    process.stdout.write(`Installing into \x1b[36m${target.name}\x1b[0m (${target.command})…\n`);
    const runResult = spawnSync(target.command, ['--install-extension', vsixPath, '--force'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (runResult.error) {
      failures.push(`${target.name}: ${runResult.error.message}`);
      process.stderr.write(
        `  \x1b[31m✗\x1b[0m Failed to execute installer: ${runResult.error.message}\n`,
      );
    } else if ((runResult.status ?? 1) !== 0) {
      failures.push(`${target.name}: exited with status ${runResult.status}`);
      process.stderr.write(`  \x1b[31m✗\x1b[0m Command returned exit code ${runResult.status}\n`);
    } else {
      successCount += 1;
      process.stdout.write(
        `  \x1b[32m✓\x1b[0m Successfully installed AIRewards into ${target.name}\n`,
      );
    }
  }

  process.stdout.write('\n');

  if (successCount === 0) {
    process.stderr.write(
      `\x1b[31mInstallation failed for all detected editors.\x1b[0m\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
    );
    return 1;
  }

  const existingConfig = loadConfig();
  const hasKey = Boolean(opts.apiKey || existingConfig.apiKey);

  process.stdout.write(
    `\x1b[32m✓ Installed successfully into ${successCount} editor(s)!\x1b[0m\n\nNext steps:\n  1. Reload your editor window (\x1b[1mCmd+Shift+P\x1b[0m / \x1b[1mCtrl+Shift+P\x1b[0m -> "Developer: Reload Window").\n${
      hasKey
        ? `  2. Press \x1b[1mCmd+Shift+P\x1b[0m -> "AIRewards: Set API Key" and paste your token (${existingConfig.apiKey?.slice(0, 12)}…).\n`
        : '  2. Get your developer API key at https://www.airewards.tech/dashboard (Profile -> Developer Settings).\n' +
          `  3. Press \x1b[1mCmd+Shift+P\x1b[0m -> "AIRewards: Set API Key" and paste your key.\n`
    }\nStart coding! Sponsored messages will appear non-intrusively in your status bar while your AI agent thinks.\n`,
  );

  return 0;
}
