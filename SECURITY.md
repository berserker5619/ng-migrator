# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `0.x` | Early development |
| `1.x` | Supported upon release |

## Supply-Chain Safety Guarantees

`ng-migrator` implements multiple security controls by design:

1. **No Automatic Package Installation:** The recommendation engine suggests alternate packages, forks, or inlining, but **never automatically installs** third-party dependencies without human approval.
2. **Git Integrity:** `ng-migrator` never makes git commits, pushes, stashes, or configuration modifications.
3. **No Credential Leakage:** Registry tokens, basic authentication headers, and personal home directories are scrubbed from generated step runbooks, markdown reports, and logs.
4. **Isolated Resolution Checks:** Dry-run lockfile checks run strictly in temporary isolated directories with `--ignore-scripts`.
5. **No Telemetry:** `ng-migrator` collects zero telemetry and transmits no data outside your configured npm registry.

## Reporting a Vulnerability

If you discover a potential security vulnerability in `ng-migrator`, please report it privately rather than opening a public issue.

Send vulnerability details to the project maintainers via GitHub private security advisories or by emailing `nizamudeen5619@gmail.com`.

