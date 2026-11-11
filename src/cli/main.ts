#!/usr/bin/env node
import { runCli } from './program.js';

const code = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: process.stdout.isTTY,
  env: process.env,
  nodeVersion: process.versions.node,
  cwd: process.cwd(),
});
process.exitCode = code;

