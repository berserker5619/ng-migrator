import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite, pathExists, readJsonIfExists, removeWithRetry, withFsRetry, writeJsonAtomic } from '../src/platform/fs.js';
import { detectEol, parseText, renderText, updateTextFile, writeGeneratedText } from '../src/platform/text.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('atomic writes', () => {
  it('writes the file and leaves no temporary files behind', async () => {
    const file = path.join(dir, 'nested dir', 'package.json');
    await atomicWrite(file, '{"a":1}\n');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n');
    expect(await readdir(path.dirname(file))).toEqual(['package.json']);
  });

  it('replaces an existing file', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'old');
    await atomicWrite(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('round-trips JSON with LF and a trailing newline, and strips a BOM on read', async () => {
    const file = path.join(dir, 'x.json');
    await writeJsonAtomic(file, { b: 1 });
    expect(await readFile(file, 'utf8')).toBe('{\n  "b": 1\n}\n');
    await writeFile(file, '\uFEFF{"c":2}');
    expect(await readJsonIfExists(file)).toEqual({ c: 2 });
    expect(await readJsonIfExists(path.join(dir, 'missing.json'))).toBeUndefined();
  });
});

describe('retries', () => {
  it('retries transient lock errors and then succeeds', async () => {
    let calls = 0;
    const result = await withFsRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return 'done';
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(
      withFsRetry(async () => {
        calls++;
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      }),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });

  it('removes trees and ignores missing paths', async () => {
    const sub = path.join(dir, 'a', 'b');
    await atomicWrite(path.join(sub, 'f.txt'), 'x');
    await removeWithRetry(path.join(dir, 'a'));
    expect(await pathExists(path.join(dir, 'a'))).toBe(false);
    await removeWithRetry(path.join(dir, 'never existed'));
  });
});

describe('line endings and BOM', () => {
  it('detects the dominant line ending', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\n')).toBe('\n');
    expect(detectEol('no breaks', '\r\n')).toBe('\r\n');
  });

  it('parses and renders symmetrically', () => {
    const raw = '\uFEFFline1\r\nline2\r\n';
    const t = parseText(raw);
    expect(t).toMatchObject({ text: 'line1\nline2\n', eol: '\r\n', bom: true });
    expect(renderText(t.text, t.eol, t.bom)).toBe(raw);
  });

  it('preserves CRLF and BOM byte for byte when editing', async () => {
    const file = path.join(dir, 'package.json');
    await writeFile(file, '\uFEFF{\r\n  "x": "^15.0.0"\r\n}\r\n');
    const changed = await updateTextFile(file, (t) => t.replace('^15.0.0', '^16.0.0'));
    expect(changed).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('\uFEFF{\r\n  "x": "^16.0.0"\r\n}\r\n');
  });

  it('preserves LF when editing', async () => {
    const file = path.join(dir, 'a.ts');
    await writeFile(file, 'a\nb\n');
    await updateTextFile(file, (t) => t.replace('b', 'c'));
    expect(await readFile(file, 'utf8')).toBe('a\nc\n');
  });

  it('never rewrites a file when nothing changes', async () => {
    const file = path.join(dir, 'mixed.ts');
    const original = 'a\r\nb\nc\r\n'; // mixed endings would be normalized by a rewrite
    await writeFile(file, original);
    const before = (await stat(file)).mtimeMs;
    expect(await updateTextFile(file, (t) => t)).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it('writes generated documents as UTF-8 with LF', async () => {
    const file = path.join(dir, 'steps', '01-angular-13-to-14.md');
    await writeGeneratedText(file, '# Step 1\r\n\r\nText\n');
    expect(await readFile(file, 'utf8')).toBe('# Step 1\n\nText\n');
  });
});

