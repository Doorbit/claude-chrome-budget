/**
 * PostToolUse hook: when a headless browser lands on a sign-in page, point the
 * model to the browser that has a window.
 *
 * The three working browsers run headless so they never take the keyboard
 * from whoever is typing (README → headless). That is right until a page asks
 * a human to sign in: nobody can see the form, the model reports "please log
 * in" to someone who has no window to log in to, and the session stalls. The
 * chrome-visible server exists for exactly that hand-over; this hook says so
 * at the moment it matters, right after the page that needs it loaded.
 *
 * Advice only: the hook never opens anything. A model that has credentials of
 * its own may well carry on in the headless browser.
 *
 * This module only decides; hooks/login-hint.mjs is the entry point.
 */

import { responseText, listedPages } from './idle-browser-core.mjs';

const PLUGIN_SERVER_PREFIX = 'plugin_chrome-budget_';
const HEADLESS_SERVERS = new Set(['chrome', 'chrome-pixel', 'chrome-debug']);
const PAGE_LOADING_TOOLS = new Set(['new_page', 'navigate_page']);
const VISIBLE_NEW_PAGE = 'mcp__plugin_chrome-budget_chrome-visible__new_page';
const OFF = new Set(['false', '0', 'off', 'no']);

// Hosts that exist to sign people in, by their first label.
const LOGIN_HOST = /^(?:auth|login|signin|sso|accounts|id|idp|identity|keycloak)[.-]/;
// Paths of sign-in forms and OAuth/OIDC authorisation endpoints. Anchored on
// whole segments, so an article whose slug mentions "login" is not one.
const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|logon|authorize|protocol\/openid-connect\/auth|oauth2?\/(?:v[\d.]+\/)?authorize)(?:\/|$)/i;

/** Whether a URL is a page whose job is to have someone sign in. */
export function looksLikeLogin(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return LOGIN_HOST.test(parsed.hostname) || LOGIN_PATH.test(parsed.pathname);
}

/** URL of the selected page in a tool response's `## Pages` listing, or null. */
export function selectedPageUrl(response) {
  const pages = listedPages(responseText(response));
  const selected = pages?.find(({ entry }) => / \[selected\](?: isolatedContext=.*)?$/.test(entry));
  if (!selected) return null;
  const entry = selected.entry.replace(/ \[selected\](?: isolatedContext=.*)?$/, '');
  // "title (url)" when the page has a title, the bare URL otherwise.
  const titled = /\(([^()\s]+)\)$/.exec(entry);
  return titled ? titled[1] : entry;
}

function serverAndTool(toolName) {
  const raw = String(toolName || '');
  if (!raw.startsWith('mcp__')) return null;
  const segments = raw.slice('mcp__'.length).split('__');
  const server = segments.slice(0, -1).join('__');
  if (!server.startsWith(PLUGIN_SERVER_PREFIX)) return null;
  return { server: server.slice(PLUGIN_SERVER_PREFIX.length), tool: segments.at(-1) };
}

/** Decide. Returns the hook output, or null to stay silent. */
export function run(input, env) {
  if (!input) return null;
  // With the option off, every browser already shows its window.
  if (OFF.has(String(env.CLAUDE_PLUGIN_OPTION_HEADLESS ?? '').toLowerCase())) return null;
  const target = serverAndTool(input.tool_name);
  if (!target || !HEADLESS_SERVERS.has(target.server) || !PAGE_LOADING_TOOLS.has(target.tool)) return null;
  const url = selectedPageUrl(input.tool_response);
  if (!url || !looksLikeLogin(url)) return null;
  const host = new URL(url).hostname;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `The page now asks for a sign-in (${host}). The ${target.server} browser is headless: nobody can ` +
        'see this page, so a person cannot sign in here. If a person should sign in, open the URL you ' +
        `wanted with ${VISIBLE_NEW_PAGE} — that browser has a window — ask them to sign in there, close ` +
        'this page, and keep working on chrome-visible: logins do not carry over between the servers. ' +
        'If you are filling in credentials yourself, carry on here.',
    },
  };
}
