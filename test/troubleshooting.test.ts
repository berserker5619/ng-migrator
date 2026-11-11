import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERRORS } from '../src/errors.js';
import { walkProject } from '../src/reader/files.js';

describe('docs/troubleshooting.md error catalog completeness', () => {
  it('lists every NGM error id in code with what happened, why, and what to do next, and has no orphan ids', async () => {
    const repoRoot = path.resolve(__dirname, '..');
    const docPath = path.join(repoRoot, 'docs', 'troubleshooting.md');
    const doc = await readFile(docPath, 'utf8');

    // 1. Collect all error IDs from ERRORS catalog in src/errors.ts
    const catalogIds = new Set(Object.keys(ERRORS));

    // 2. Also scan all src/**/*.ts files for any literal NGM-XXXX strings
    const srcFiles = await walkProject(path.join(repoRoot, 'src'), { extensions: ['.ts'] });
    const referencedInCode = new Set<string>(catalogIds);
    for (const rel of srcFiles) {
      const content = await readFile(path.join(repoRoot, 'src', rel), 'utf8');
      const matches = content.match(/\bNGM-\d{4}\b/g) ?? [];
      for (const id of matches) {
        referencedInCode.add(id);
      }
    }

    // Every NGM-XXXX in src/**/*.ts must be registered in ERRORS
    expect([...referencedInCode].sort()).toEqual([...catalogIds].sort());

    // 3. Parse ## NGM-XXXX sections from docs/troubleshooting.md
    const headingRegex = /^## (NGM-\d{4}):\s+(.+)$/gm;
    const docSections = new Map<string, { title: string; body: string }>();
    const matches = [...doc.matchAll(headingRegex)];

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      const id = m[1]!;
      const title = m[2]!.trim();
      const start = m.index! + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : doc.length;
      const body = doc.slice(start, end);
      docSections.set(id, { title, body });
    }

    const docIds = [...docSections.keys()].sort();
    const codeIds = [...catalogIds].sort();

    // Bi-directional equality: no missing page entries and no extra/orphan entries in docs
    expect(docIds).toEqual(codeIds);

    // Verify each entry documents what happened, why, and what to do next
    for (const id of codeIds) {
      const section = docSections.get(id);
      expect(section, `Missing section for ${id}`).toBeDefined();
      expect(section?.body).toContain('**What happened:**');
      expect(section?.body).toContain('**Why:**');
      expect(section?.body).toContain('**What to do next:**');
    }
  });
});

