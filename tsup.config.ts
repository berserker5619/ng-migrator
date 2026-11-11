import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  external: ['typescript'],
});
