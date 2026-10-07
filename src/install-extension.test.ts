import { describe, expect, it } from 'vitest';
import {
  editorTable,
  installExtensionCommand,
  parseInstallArgs,
  resolveTargets,
} from './install-extension.js';

describe('install-extension argument parsing', () => {
  it('parses defaults correctly', () => {
    const opts = parseInstallArgs([]);
    expect(opts.editor).toBe('all');
    expect(opts.dryRun).toBe(false);
    expect(opts.url).toContain('airewards-vscode-0.1.0.vsix');
    expect(opts.apiKey).toBeUndefined();
  });

  it('parses valid options', () => {
    const opts = parseInstallArgs([
      '--editor',
      'cursor',
      '--dry-run',
      '--url',
      'https://example.com/custom.vsix',
      '--api-key',
      'air_dev_testkey123',
    ]);
    expect(opts.editor).toBe('cursor');
    expect(opts.dryRun).toBe(true);
    expect(opts.url).toBe('https://example.com/custom.vsix');
    expect(opts.apiKey).toBe('air_dev_testkey123');
  });

  it('rejects invalid editor targets', () => {
    expect(() => parseInstallArgs(['--editor', 'sublime'])).toThrow(
      '--editor must be one of: all, code, cursor, windsurf, codium',
    );
  });

  it('rejects invalid urls', () => {
    expect(() => parseInstallArgs(['--url', 'ftp://badurl'])).toThrow(
      '--url must be a valid http or https URL',
    );
  });

  it('rejects unknown arguments', () => {
    expect(() => parseInstallArgs(['--foobar'])).toThrow('Unknown argument "--foobar"');
  });
});

describe('editorTable configuration', () => {
  it('includes VS Code, Cursor, Windsurf, and VSCodium', () => {
    const table = editorTable();
    expect(table).toHaveProperty('code');
    expect(table).toHaveProperty('cursor');
    expect(table).toHaveProperty('windsurf');
    expect(table).toHaveProperty('codium');

    expect(table.code.name).toBe('Visual Studio Code');
    expect(table.cursor.name).toBe('Cursor');
    expect(table.windsurf.name).toBe('Windsurf');
    expect(table.codium.name).toBe('VSCodium');

    // Each should define mac, win, and linux paths
    for (const key of ['code', 'cursor', 'windsurf', 'codium'] as const) {
      expect(table[key].mac.length).toBeGreaterThan(0);
      expect(table[key].win.length).toBeGreaterThan(0);
      expect(table[key].linux.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveTargets', () => {
  it('respects custom editor-path', () => {
    const targets = resolveTargets({
      editor: 'all',
      editorPath: '/custom/bin/my-editor',
      dryRun: true,
      url: 'https://example.com/v.vsix',
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].command).toBe('/custom/bin/my-editor');
  });
});

describe('dry-run execution', () => {
  it('runs cleanly in dry-run mode without modifying system', async () => {
    const code = await installExtensionCommand(['--dry-run', '--editor', 'code']);
    expect(code).toBe(0);
  });
});
