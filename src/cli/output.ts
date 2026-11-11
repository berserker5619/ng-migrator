export interface OutputOptions {
  color: boolean;
  ascii: boolean;
  verbose: boolean;
}

export interface Writer {
  write(text: string): void;
}

/** Colors and symbols that degrade gracefully for old terminals and CI logs. */
export class Output {
  constructor(
    private readonly out: Writer,
    private readonly err: Writer,
    readonly options: OutputOptions,
  ) {}

  private paint(code: number, text: string): string {
    return this.options.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  get symbols() {
    return this.options.ascii
      ? { ok: '[ok]', warn: '[!]', fail: '[x]', bullet: '-' }
      : { ok: '✔', warn: '⚠', fail: '✖', bullet: '•' };
  }

  info(text: string): void {
    this.out.write(`${text}\n`);
  }

  success(text: string): void {
    this.out.write(`${this.paint(32, this.symbols.ok)} ${text}\n`);
  }

  warn(text: string): void {
    this.err.write(`${this.paint(33, this.symbols.warn)} ${text}\n`);
  }

  error(text: string): void {
    this.err.write(`${this.paint(31, this.symbols.fail)} ${text}\n`);
  }

  debug(text: string): void {
    if (this.options.verbose) this.err.write(`${this.paint(90, text)}\n`);
  }
}

/** Color on only for an interactive terminal, and never when NO_COLOR is set or --no-color is given. */
export function shouldUseColor(flag: boolean | undefined, isTTY: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(isTTY);
}

