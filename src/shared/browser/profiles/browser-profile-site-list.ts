export const MAX_BROWSER_SITE_LIST_ENTRIES = 256

export type BrowserSiteListEntryError =
  | 'empty'
  | 'invalid'
  | 'ip-address'
  | 'port-path-or-scheme'
  | 'single-label'

export type BrowserSiteListParseResult =
  | { ok: true; entries: string[] }
  | { ok: false; error: BrowserSiteListEntryError | 'too-many'; line?: number }

export type CompiledBrowserSiteList = {
  exact: ReadonlySet<string>
  /** Bases of `*.base` entries: they match subdomains of `base`, never `base` itself. */
  wildcardBases: ReadonlySet<string>
}

const LABEL = /^[a-z0-9-]{1,63}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])
// file: can read local disk and ftp: is not a hostname-matched protocol, so a list shuts both.
const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:'])

// A single label (`com`, `*.com`) would admit a whole top-level domain; only `localhost` stays.
const SINGLE_LABEL_EXCEPTION = 'localhost'

function normalizeHostname(raw: string, wildcard: boolean): string | BrowserSiteListEntryError {
  if (/[:/\\?#@\s%[\]]/.test(raw)) {
    return 'port-path-or-scheme'
  }
  let hostname: string
  try {
    hostname = new URL(`http://${raw}/`).hostname
  } catch {
    return 'invalid'
  }
  if (IPV4.test(hostname)) {
    return 'ip-address'
  }
  const labels = hostname.split('.')
  if (hostname.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return 'invalid'
  }
  if (labels.length === 1 && (wildcard || hostname !== SINGLE_LABEL_EXCEPTION)) {
    return 'single-label'
  }
  return hostname
}

/**
 * Normalizes one `host` or `*.host` entry to lowercase punycode, or says why it is not one.
 * IP literals and single-label names (except exact `localhost`) are rejected.
 */
export function normalizeBrowserSiteListEntry(
  raw: string
): { ok: true; entry: string } | { ok: false; error: BrowserSiteListEntryError } {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) {
    return { ok: false, error: 'empty' }
  }
  const wildcard = trimmed.startsWith('*.')
  const hostname = normalizeHostname(wildcard ? trimmed.slice(2) : trimmed, wildcard)
  if (
    hostname === 'port-path-or-scheme' ||
    hostname === 'invalid' ||
    hostname === 'ip-address' ||
    hostname === 'single-label'
  ) {
    return { ok: false, error: hostname }
  }
  return { ok: true, entry: wildcard ? `*.${hostname}` : hostname }
}

/** One entry per non-blank line; duplicates collapse. */
export function parseBrowserSiteList(text: string): BrowserSiteListParseResult {
  return normalizeBrowserSiteListEntries(text.split(/\r?\n/), true)
}

export function normalizeBrowserSiteListEntries(
  rawEntries: readonly string[],
  skipBlank = false
): BrowserSiteListParseResult {
  const entries = new Set<string>()
  for (const [index, raw] of rawEntries.entries()) {
    if (skipBlank && !raw.trim()) {
      continue
    }
    const result = normalizeBrowserSiteListEntry(raw)
    if (!result.ok) {
      return { ok: false, error: result.error, line: index + 1 }
    }
    entries.add(result.entry)
  }
  if (entries.size > MAX_BROWSER_SITE_LIST_ENTRIES) {
    return { ok: false, error: 'too-many' }
  }
  return { ok: true, entries: [...entries] }
}

export function compileBrowserSiteList(entries: readonly string[]): CompiledBrowserSiteList {
  const exact = new Set<string>()
  const wildcardBases = new Set<string>()
  for (const entry of entries) {
    if (entry.startsWith('*.')) {
      wildcardBases.add(entry.slice(2))
    } else {
      exact.add(entry)
    }
  }
  return { exact, wildcardBases }
}

function hostnameAllowed(list: CompiledBrowserSiteList, hostname: string): boolean {
  if (list.exact.has(hostname)) {
    return true
  }
  for (let dot = hostname.indexOf('.'); dot !== -1; dot = hostname.indexOf('.', dot + 1)) {
    if (list.wildcardBases.has(hostname.slice(dot + 1))) {
      return true
    }
  }
  return false
}

/**
 * Hostname check for http(s)/ws(s) only. Non-network schemes (data:, blob:, about:, devtools:,
 * extension and Orca-internal schemes) stay allowed; file: and ftp: are blocked.
 */
export function isUrlAllowedBySiteList(list: CompiledBrowserSiteList, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return false
  }
  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) {
    return true
  }
  const hostname = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname
  return hostnameAllowed(list, hostname)
}

/** Whether an already-normalized entry only admits hosts the list admits today. */
export function isSiteListEntryCovered(list: CompiledBrowserSiteList, entry: string): boolean {
  if (!entry.startsWith('*.')) {
    return hostnameAllowed(list, entry)
  }
  const base = entry.slice(2)
  return list.wildcardBases.has(base) || hostnameAllowed({ ...list, exact: new Set() }, base)
}

export type BrowserSiteListSetResult =
  | { ok: true; hosts: string[] }
  | {
      ok: false
      reason:
        | 'unavailable'
        | 'invalid'
        | 'cancelled'
        | 'save-failed'
        // The saved lists could not be read, so edits are refused rather than risk overwriting them.
        | 'load-failed'
        // The list changed while the confirmation dialog was open; the edit was not applied.
        | 'changed'
    }
