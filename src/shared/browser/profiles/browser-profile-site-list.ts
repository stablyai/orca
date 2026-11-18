export const MAX_BROWSER_SITE_LIST_ENTRIES = 256

export type BrowserSiteListParseResult =
  | { ok: true; entries: string[] }
  | { ok: false; invalid?: string }

export type CompiledBrowserSiteList = {
  exact: ReadonlySet<string>
  /** `*.base` entries match subdomains of base, never base itself. */
  wildcardBases: ReadonlySet<string>
}

const LABEL = /^[a-z0-9-]{1,63}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])
const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:'])

function normalizeHostname(raw: string, wildcard: boolean): string | null {
  if (/[:/\\?#@\s%[\]]/.test(raw)) {
    return null
  }
  let hostname: string
  try {
    hostname = new URL(`http://${raw}/`).hostname
  } catch {
    return null
  }
  const labels = hostname.split('.')
  if (IPV4.test(hostname) || hostname.length > 253 || !labels.every((l) => LABEL.test(l))) {
    return null
  }
  // A single label would admit a whole top-level domain; only exact localhost is allowed.
  return labels.length === 1 && (wildcard || hostname !== 'localhost') ? null : hostname
}

export function normalizeBrowserSiteListEntry(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  const wildcard = trimmed.startsWith('*.')
  const hostname = normalizeHostname(wildcard ? trimmed.slice(2) : trimmed, wildcard)
  return hostname === null ? null : wildcard ? `*.${hostname}` : hostname
}

export function normalizeBrowserSiteListEntries(
  rawEntries: readonly string[]
): BrowserSiteListParseResult {
  const entries = new Set<string>()
  for (const raw of rawEntries) {
    const entry = normalizeBrowserSiteListEntry(raw)
    if (entry === null) {
      return { ok: false, invalid: raw }
    }
    entries.add(entry)
  }
  return entries.size > MAX_BROWSER_SITE_LIST_ENTRIES
    ? { ok: false }
    : { ok: true, entries: [...entries] }
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

/** Non-network schemes stay allowed; file: and ftp: are blocked. */
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

export function isSiteListEntryCovered(list: CompiledBrowserSiteList, entry: string): boolean {
  if (!entry.startsWith('*.')) {
    return hostnameAllowed(list, entry)
  }
  const base = entry.slice(2)
  return list.wildcardBases.has(base) || hostnameAllowed({ ...list, exact: new Set() }, base)
}

export type BrowserSiteListSetResult =
  | { ok: true; hosts: string[] }
  | { ok: false; reason: 'unavailable' | 'invalid' | 'cancelled' | 'save-failed' }
