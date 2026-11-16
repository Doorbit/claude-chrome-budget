#!/usr/bin/env node
/**
 * Entry point of the PostToolUse hook on close_page. The decisions live in
 * idle-browser-core.mjs; this file only wires them to stdin, ps and kill.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run, PS_ARGS, PS_TIMEOUT_MS } from './idle-browser-core.mjs';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

// A hook that fails must fail silently: anything unexpected — down to a stack
// overflow on absurdly nested input — ends here as "nothing to do".
let output = null;
try {
  output = run(input, {
    pid: process.pid,
    env: process.env,
    processTable: () => execFileSync('ps', PS_ARGS, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
    kill: (target) => process.kill(target, 'SIGTERM'),
  });
} catch {
  process.exit(0);
}
if (output) process.stdout.write(JSON.stringify(output));
