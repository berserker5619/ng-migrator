import { readFile } from 'node:fs/promises';
import { atomicWrite } from './fs.js';

export type Eol = '\n' | '\r\n';

const BOM = '\uFEFF';

export interface TextFile {
  /** Content with the BOM removed and line endings normalized to LF. */
  text: string;
  /** The file's dominant line ending, restored on write. */
  eol: Eol;
  bom: boolean;
  /** The exact original content (BOM and line endings included). */
  original: string;
}

/** Dominant line ending; `fallback` when the text has no line breaks. */
export function detectEol(text: string, fallback: Eol = '\n'): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  if (crlf === 0 && lf === 0) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

export function parseText(raw: string, fallbackEol: Eol = '\n'): TextFile {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  return { text: body.replace(/\r\n/g, '\n'), eol: detectEol(body, fallbackEol), bom, original: raw };
}

/** Re-apply a file's line ending and BOM to LF-normalized text. */
export function renderText(text: string, eol: Eol, bom: boolean): string {
  const lf = text.replace(/\r\n/g, '\n');
  return (bom ? BOM : '') + (eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf);
}

export async function readTextFile(file: string): Promise<TextFile> {
  return parseText(await readFile(file, 'utf8'));
}

/**
 * Transform an existing text file while preserving its line endings and BOM.
 * The transform works on LF text. If the result is unchanged, the file is not
 * touched at all (byte for byte). Returns true if the file was written.
 */
export async function updateTextFile(file: string, transform: (text: string) => string): Promise<boolean> {
  const current = await readTextFile(file);
  const next = transform(current.text);
  if (next === current.text) return false;
  await atomicWrite(file, renderText(next, current.eol, current.bom));
  return true;
}

/** Write a file the tool generates (reports, step documents): UTF-8, LF, no BOM. */
export async function writeGeneratedText(file: string, text: string): Promise<void> {
  await atomicWrite(file, renderText(text, '\n', false));
}

