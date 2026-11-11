import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: false,
  splitting: false,
  dts: false,
  external: ['typescript'],
});
