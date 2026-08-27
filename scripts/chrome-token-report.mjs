#!/usr/bin/env node
/**
 * Reports what the Chrome DevTools MCP server actually costs you, measured
 * from Claude Code's own transcripts rather than estimated.
 *
 *   node scripts/chrome-token-report.mjs [--since YYYY-MM] [--project <substring>] [--json]
 *
 * Two numbers matter and only one of them is obvious:
 *
 *   written  — tokens the browser tools put into conversations, counted once.
 *   carried  — the same tokens re-sent on every later request in that session.
 *              This is the number that fills context windows and forces
 *              compaction, and it is typically three orders of magnitude
 *              larger than "written".
 */

import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SINCE = opt('since');
const PROJECT = opt('project');
const AS_JSON = argv.includes('--json');
const ROOT = join(homedir(), '.claude', 'projects');

// Anthropic bills images by area, not by file size: roughly (w*h)/750 tokens
// after the longest edge is clamped to 1568px. Compression settings therefore
// do nothing for context cost; only the pixel dimensions do.
function readDimensions(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
    if (chunk === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (SOF_MARKERS.has(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// Anthropic bills images by area, not by file size: roughly (w*h)/750 tokens
// after the longest edge is clamped to 1568px. Compression settings therefore
// do nothing for context cost; only the pixel dimensions do. PNG, JPEG and WebP
// all have to be read here — recommending WebP and then only measuring PNG
// would quietly report every WebP screenshot as a guess.
function imageTokens(base64) {
  try {
    // A JPEG's size marker can sit well past the header, so decode generously.
    const buf = Buffer.from(base64.slice(0, 60000) + '==', 'base64');
    const size = readDimensions(buf);
    if (!size) return 1400;
    let [w, h] = size;
    if (!w || !h) return 1400;
    if (Math.max(w, h) > 1568) {
      const scale = 1568 / Math.max(w, h);
      w *= scale;
      h *= scale;
    }
    return Math.round((w * h) / 750);
  } catch {
    return 1400;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const byTool = new Map();
const byProject = new Map();
const bySection = new Map();
let images = 0;
let imageTok = 0;
let written = 0;
let carried = 0;
let sessions = 0;
let bodyTok = 0;

const bump = (map, key, field, n) => {
  const row = map.get(key) ?? { calls: 0, tokens: 0 };
  row[field] += n;
  map.set(key, row);
};

for (const project of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  if (PROJECT && !project.name.includes(PROJECT)) continue;
  for (const file of walk(join(ROOT, project.name))) {
    if (statSync(file).size === 0) continue;
    const pending = new Map();
    const events = [];
    let turn = 0;
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (SINCE && typeof rec.timestamp === 'string' && rec.timestamp.slice(0, 7) < SINCE) continue;
      if (rec.type === 'assistant') turn++;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === 'tool_use') {
          pending.set(c.id, c.name ?? '');
        } else if (c?.type === 'tool_result') {
          const name = pending.get(c.tool_use_id);
          if (!name?.startsWith('mcp__') || !name.includes('chrome')) continue;
          const tool = name.split('__').slice(2).join('__');
          let tokens = 0;
          let text = '';
          const body = c.content;
          if (typeof body === 'string') {
            text = body;
            tokens = Math.round(body.length / 4);
          } else if (Array.isArray(body)) {
            for (const part of body) {
              if (part?.type === 'text') {
                text += part.text ?? '';
                tokens += Math.round((part.text ?? '').length / 4);
              } else if (part?.type === 'image') {
                const t = imageTokens(part.source?.data ?? '');
                images++;
                imageTok += t;
                tokens += t;
              }
            }
          }
          // Split the text into the answer itself and the context blocks the
          // server appends to it — that ratio is usually the finding.
          const parts = text.split(/^(## .*)$/m);
          bodyTok += Math.round((parts[0]?.length ?? 0) / 4);
          for (let i = 1; i < parts.length; i += 2) {
            const heading = parts[i].trim().slice(0, 40);
            bump(bySection, heading, 'tokens', Math.round((parts[i + 1]?.length ?? 0) / 4));
            bump(bySection, heading, 'calls', 1);
          }
          bump(byTool, tool, 'calls', 1);
          bump(byTool, tool, 'tokens', tokens);
          bump(byProject, project.name, 'calls', 1);
          bump(byProject, project.name, 'tokens', tokens);
          written += tokens;
          events.push([turn, tokens]);
        }
      }
    }
    if (events.length) {
      sessions++;
      for (const [at, tokens] of events) carried += tokens * (turn - at);
    }
  }
}

const n = (x) => x.toLocaleString('en-US');
const top = (map, k = 10) =>
  [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, k);

if (AS_JSON) {
  console.log(JSON.stringify({
    sessions, written, carried, images, imageTokens: imageTok, bodyTokens: bodyTok,
    tools: Object.fromEntries(byTool), projects: Object.fromEntries(byProject),
    sections: Object.fromEntries(bySection),
  }, null, 2));
  process.exit(0);
}

const textTok = written - imageTok;
console.log(`\nChrome MCP token report${SINCE ? ` (since ${SINCE})` : ''}${PROJECT ? ` [project ~ ${PROJECT}]` : ''}`);
console.log(`  sessions using the browser   ${n(sessions)}`);
console.log(`  tokens written into contexts ${n(written)}`);
console.log(`  tokens carried (re-sent)     ${n(carried)}  ->  ${(carried / Math.max(written, 1)).toFixed(0)}x`);
console.log(`  images                       ${n(images)}  (${n(imageTok)} tokens, avg ${n(Math.round(imageTok / Math.max(images, 1)))})`);
console.log(`  text                         ${n(textTok)} tokens, of which ${n(bodyTok)} (${Math.round((bodyTok / Math.max(textTok, 1)) * 100)}%) is the answer itself`);

console.log('\n  tool                          calls      tokens   avg');
for (const [tool, r] of top(byTool, 12)) {
  console.log(`  ${tool.padEnd(28)}${String(r.calls).padStart(6)}${n(r.tokens).padStart(12)}${String(Math.round(r.tokens / r.calls)).padStart(6)}`);
}

console.log('\n  appended section                       occurrences      tokens');
for (const [heading, r] of top(bySection, 8)) {
  console.log(`  ${heading.padEnd(40)}${String(r.calls).padStart(12)}${n(r.tokens).padStart(12)}`);
}

console.log('\n  project                                              calls      tokens');
for (const [project, r] of top(byProject, 8)) {
  console.log(`  ${project.replace(/^-Users-[^-]+-/, '').slice(0, 48).padEnd(50)}${String(r.calls).padStart(6)}${n(r.tokens).padStart(12)}`);
}
console.log('');
