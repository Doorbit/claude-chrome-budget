import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { looksLikeLogin, selectedPageUrl, run } from '../hooks/login-hint-core.mjs';

const KEYCLOAK = 'https://auth.doorbit.com/login/realms/doorbit/protocol/openid-connect/auth?client_id=doorbit-public&redirect_uri=https%3A%2F%2Fdoorbit.com%2F';
const pages = (selected) => ({ content: [{ type: 'text', text: `## Pages\n1: about:blank\n2: ${selected} [selected]` }] });
const input = (server, url, tool = 'new_page') => ({
  tool_name: `mcp__plugin_chrome-budget_${server}__${tool}`,
  tool_input: { url: 'https://doorbit.com/account/' },
  tool_response: pages(url),
});

// --- looksLikeLogin ---------------------------------------------------------

test('looksLikeLogin recognises the usual sign-in pages', () => {
  for (const url of [
    KEYCLOAK,
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
    'https://accounts.google.com/v3/signin/identifier?continue=x',
    'https://github.com/login?return_to=%2Fsettings',
    'https://example.com/users/sign_in',
    'https://example.com/signin',
    'https://sso.example.com/',
    'https://example.com/oauth/authorize?response_type=code',
  ]) assert.ok(looksLikeLogin(url), url);
});

test('looksLikeLogin leaves ordinary pages alone', () => {
  for (const url of [
    'about:blank',
    'https://doorbit.com/account/admin/scan-diagnostics/1/?tab=replay',
    'https://example.com/blog/how-to-login-faster',
    'https://example.com/blog/no-more-login',
    'https://author.example.com/',
    'http://localhost:8087/listing/1/building/',
    'not a url',
  ]) assert.equal(looksLikeLogin(url), false, url);
});

// --- selectedPageUrl --------------------------------------------------------

test('selectedPageUrl reads the selected entry, with or without a title', () => {
  assert.equal(selectedPageUrl(pages(KEYCLOAK)), KEYCLOAK);
  assert.equal(selectedPageUrl(pages(`Sign in to doorbit (${KEYCLOAK})`)), KEYCLOAK);
  assert.equal(selectedPageUrl({ content: [{ type: 'text', text: '## Pages\n1: about:blank' }] }), null);
});

// --- run --------------------------------------------------------------------

test('a login page on a headless server points to chrome-visible', () => {
  const output = run(input('chrome', KEYCLOAK), {});
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /auth\.doorbit\.com/);
  assert.match(text, /mcp__plugin_chrome-budget_chrome-visible__new_page/);
  assert.match(text, /headless/);
});

test('navigate_page and the other headless servers get the hint too', () => {
  assert.ok(run(input('chrome-pixel', KEYCLOAK, 'navigate_page'), {}));
  assert.ok(run(input('chrome-debug', KEYCLOAK), {}));
});

test('no hint on chrome-visible, on ordinary pages, or when the browsers have a window', () => {
  assert.equal(run(input('chrome-visible', KEYCLOAK), {}), null);
  assert.equal(run(input('chrome', 'https://doorbit.com/account/'), {}), null);
  assert.equal(run(input('chrome', KEYCLOAK), { CLAUDE_PLUGIN_OPTION_HEADLESS: 'false' }), null);
  assert.equal(run(input('chrome', KEYCLOAK, 'click'), {}), null);
  assert.equal(run({ tool_name: 'mcp__other__new_page', tool_response: pages(KEYCLOAK) }, {}), null);
});

test('the entry point stays silent on garbage and speaks on a login page', () => {
  const entry = fileURLToPath(new URL('../hooks/login-hint.mjs', import.meta.url));
  const silent = spawnSync(process.execPath, [entry], { input: 'not json', encoding: 'utf8' });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, '');
  const hint = spawnSync(process.execPath, [entry], { input: JSON.stringify(input('chrome', KEYCLOAK)), encoding: 'utf8', env: {} });
  assert.equal(hint.status, 0);
  assert.match(JSON.parse(hint.stdout).hookSpecificOutput.additionalContext, /chrome-visible/);
});
