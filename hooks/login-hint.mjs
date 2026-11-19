#!/usr/bin/env node
/**
 * Entry point of the PostToolUse hook on new_page and navigate_page. The
 * decision lives in login-hint-core.mjs; this file only wires it to stdin.
 */

import { readFileSync } from 'node:fs';
import { run } from './login-hint-core.mjs';

let output = null;
try {
  output = run(JSON.parse(readFileSync(0, 'utf8')), process.env);
} catch {
  process.exit(0);
}
if (output) process.stdout.write(JSON.stringify(output));
