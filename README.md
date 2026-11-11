# ng-migrator

Plans Angular upgrades one major version at a time (always n-1 to n), together with their dependencies, and writes a reviewable Markdown document for every step. It never commits anything.

> **Status:** early development (phase 0 of the 1.0 roadmap). Commands are defined but not implemented yet.

```
npx ng-migrator doctor           # check the machine and project
npx ng-migrator analyze          # what the project has and what blocks it
npx ng-migrator plan --to 19     # one document per step, changes nothing
npx ng-migrator status           # planned, approved, done or failed steps
npx ng-migrator approve 3        # approve step 3 after reading its document
```

## Requirements

- Node 22.12 or newer to run the tool. Old project toolchains can run under their own Node through `commandPrefix` in `ng-migrator.config.json`.

## Development

```
npm ci
npm run check    # lint, typecheck, build, test
```

CI runs on Ubuntu, macOS and Windows with Node 22, 24 and 26.

## License

MIT

