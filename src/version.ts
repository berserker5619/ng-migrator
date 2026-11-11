import { createRequire } from 'node:module';

// Works from both src/ (tests) and dist/ (bundled): package.json is one level up.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string; engines: { node: string } };

export const TOOL_NAME = 'ng-migrator';
export const TOOL_VERSION: string = pkg.version;
export const NODE_RANGE: string = pkg.engines.node;

