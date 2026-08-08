/**
 * Classify URLs for OS app handoff. http(s) stay on existing open paths;
 * other schemes need an explicit user-approved openExternal (#13225 terminal,
 * #12719 embedded browser).
 */

const DENIED_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'about:',
  'blob:',
  'chrome:',
  'chrome-extension:',
  'ms-appx:',
  'ms-appx-web:'
])

export type ExternalAppUrlClassification =
  | { ok: true; kind: 'http'; url: string; protocol: string }
  | { ok: true; kind: 'custom'; url: string; protocol: string; schemeLabel: string }
  | { ok: false; reason: 'invalid' | 'denied' | 'unsupported' }

/** Match http(s) and custom app schemes like obsidian://, vscode:// in terminal text. */
// Why: trailing punctuation stripped like xterm's default http regex; ^/[ unescaped
// inside [] (oxlint no-useless-escape).
export const TERMINAL_WEB_AND_APP_URL_REGEX =
  /(?:https?|HTTPS?|[a-zA-Z][a-zA-Z0-9+.-]{1,31}):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/

export function classifyExternalAppUrl(rawUrl: string): ExternalAppUrlClassification {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return { ok: false, reason: 'invalid' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const protocol = parsed.protocol.toLowerCase()
  if (protocol === 'http:' || protocol === 'https:') {
    return { ok: true, kind: 'http', url: parsed.toString(), protocol }
  }
  if (DENIED_PROTOCOLS.has(protocol)) {
    return { ok: false, reason: 'denied' }
  }
  // Why: scheme must look like an app protocol (letters + optional +.-), not a
  // single-letter drive-style or empty host with no path (noise from false matches).
  if (!/^[a-z][a-z0-9+.-]*:$/i.test(protocol) || protocol.length < 3) {
    return { ok: false, reason: 'unsupported' }
  }
  if (!parsed.hostname && !parsed.pathname && !parsed.search && !parsed.hash) {
    return { ok: false, reason: 'invalid' }
  }
  const schemeLabel = protocol.slice(0, -1)
  return {
    ok: true,
    kind: 'custom',
    url: parsed.toString(),
    protocol,
    schemeLabel
  }
}
