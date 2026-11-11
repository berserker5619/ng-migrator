import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, commandPrefixForStep, readConfigFile, resolveConfig, validateFileConfig } from '../src/config/config.js';
import { NgmError } from '../src/errors.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('config', () => {
  it('is empty when there is no config file', async () => {
    expect(await readConfigFile(dir)).toEqual({ config: {}, warnings: [] });
  });

  it('reads and validates a full config file', async () => {
    const full = {
      packageManager: 'pnpm',
      rules: ['./migration-rules.json'],
      neverTouch: ['some-internal-lib'],
      pinned: { rxjs: '7.8.1' },
      alternates: { allow: [], deny: ['bad-lib'] },
      verify: { build: 'npm run build', lint: 'npm run lint', test: 'npm test' },
      cacheDir: '.ng-migrator/cache',
      commandPrefix: { '14': 'fnm exec --using 14 --' },
    };
    await writeFile(path.join(dir, CONFIG_FILE), JSON.stringify(full));
    expect(await readConfigFile(dir)).toEqual({ config: full, warnings: [] });
  });

  it('warns about unknown keys', () => {
    expect(validateFileConfig({ typo: 1 }).warnings).toEqual([`${CONFIG_FILE}: unknown key "typo" is ignored.`]);
  });

  it.each([
    [{ packageManager: 'bun' }, 'packageManager'],
    [{ rules: 'x' }, 'rules'],
    [{ pinned: { rxjs: 7 } }, 'pinned'],
    [{ alternates: { allow: 'x' } }, 'alternates.allow'],
    [{ verify: { build: 1 } }, 'verify.build'],
    [{ commandPrefix: { next: 'x' } }, 'commandPrefix'],
    [[], '(root)'],
  ])('rejects invalid %j', (raw, field) => {
    expect(() => validateFileConfig(raw)).toThrow(new RegExp(field.replace('.', '\\.')));
  });

  it('reports invalid JSON as a config error', async () => {
    await writeFile(path.join(dir, CONFIG_FILE), '{ nope');
    await expect(readConfigFile(dir)).rejects.toMatchObject({ id: 'NGM-2003' });
    await expect(readConfigFile(dir)).rejects.toBeInstanceOf(NgmError);
  });

  it('applies precedence: flags, then file, then detection, then default', () => {
    expect(resolveConfig({ packageManager: 'yarn' }, { packageManager: 'pnpm' }, { packageManager: 'npm' }).packageManager).toBe('yarn');
    expect(resolveConfig({}, { packageManager: 'pnpm' }, { packageManager: 'yarn' }).packageManager).toBe('pnpm');
    expect(resolveConfig({}, {}, { packageManager: 'yarn' }).packageManager).toBe('yarn');
    expect(resolveConfig({}, {}, {}).packageManager).toBe('npm');
    expect(resolveConfig({ rules: ['b.json'] }, { rules: ['a.json'] }, {}).rules).toEqual(['a.json', 'b.json']);
  });

  it('picks the command prefix for a step by target major', () => {
    expect(commandPrefixForStep({ commandPrefix: 'volta run --node 16 --' }, 15)).toBe('volta run --node 16 --');
    expect(commandPrefixForStep({ commandPrefix: { '14': 'fnm exec --using 14 --' } }, 14)).toBe('fnm exec --using 14 --');
    expect(commandPrefixForStep({ commandPrefix: { '14': 'x' } }, 15)).toBeUndefined();
    expect(commandPrefixForStep({ commandPrefix: undefined }, 15)).toBeUndefined();
  });
});

