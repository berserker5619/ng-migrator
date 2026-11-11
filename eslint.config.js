import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.ng-migrator/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              message: 'Use src/platform/process.ts so every subprocess goes through the git guard.',
            },
            {
              name: 'child_process',
              message: 'Use src/platform/process.ts so every subprocess goes through the git guard.',
            },
          ],
        },
      ],
    },
  },
);

