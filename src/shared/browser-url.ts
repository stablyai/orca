import { ORCA_BROWSER_BLANK_URL } from './constants'

const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:\/.*)?$/i

// Why: bare words like "react hooks" should trigger a search, but inputs that
// look like domain names ("example.com", "foo.bar/path") should navigate directly.
// A single-word input containing a dot with a valid TLD-like suffix is treated as
// a URL attempt, not a search query.
const LOOKS_LIKE_URL_PATTERN = /^[^\s]+\.[a-z]{2,}(\/.*)?$/i

export type SearchEngine = 'google' | 'duckduckgo' | 'bing' | 'kagi'

export type SearchUrlOptions = {
  kagiSessionLink?: string | null
}

export const SEARCH_ENGINE_LABELS: Record<SearchEngine, string> = {
  google: 'Google',
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  kagi: 'Kagi'
}

const SEARCH_ENGINE_URLS: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  kagi: 'https://kagi.com/search?q='
}

export const DEFAULT_SEARCH_ENGINE: SearchEngine = 'google'

export function normalizeKagiSessionLink(rawLink: string): string | null {
  const trimmed = rawLink.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    const hostname = parsed.hostname.toLowerCase()
    const token = parsed.searchParams.get('token')?.trim()
    // Why: reject user-info credentials and non-default ports so a hostile
    // paste cannot smuggle alternate auth or a redirected origin into the
    // saved session URL. Accept /search and /search/ since Kagi's settings
    // page emits both.
    const pathOk = parsed.pathname === '/search' || parsed.pathname === '/search/'
    if (
      parsed.protocol !== 'https:' ||
      (hostname !== 'kagi.com' && hostname !== 'www.kagi.com') ||
      !pathOk ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      !token
    ) {
      return null
    }
    parsed.searchParams.delete('q')
    // Why: collapse any duplicate token params so we don't echo two bearer
    // values back to Kagi on every search.
    parsed.searchParams.set('token', token)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

export function redactKagiSessionToken(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (
      parsed.protocol === 'https:' &&
      (hostname === 'kagi.com' || hostname === 'www.kagi.com') &&
      (parsed.pathname === '/search' || parsed.pathname === '/search/') &&
      parsed.searchParams.has('token')
    ) {
      // Why: Kagi private-session links carry an account bearer token. Strip it
      // before URLs reach display, history, or persisted browser-tab state.
      parsed.searchParams.delete('token')
      return parsed.toString()
    }
  } catch {
    // Keep non-URL inputs unchanged.
  }
  return rawUrl
}

function buildKagiSessionSearchUrl(
  query: string,
  sessionLink: string | null | undefined
): string | null {
  if (!sessionLink) {
    return null
  }
  const normalized = normalizeKagiSessionLink(sessionLink)
  if (!normalized) {
    return null
  }
  const parsed = new URL(normalized)
  parsed.searchParams.set('q', query)
  return parsed.toString()
}

export function buildSearchUrl(
  query: string,
  engine: SearchEngine = DEFAULT_SEARCH_ENGINE,
  options: SearchUrlOptions = {}
): string {
  if (engine === 'kagi') {
    const sessionSearchUrl = buildKagiSessionSearchUrl(query, options.kagiSessionLink)
    if (sessionSearchUrl) {
      return sessionSearchUrl
    }
  }
  return `${SEARCH_ENGINE_URLS[engine]}${encodeURIComponent(query)}`
}

export function looksLikeSearchQuery(input: string): boolean {
  if (input.includes(' ')) {
    return true
  }
  if (LOOKS_LIKE_URL_PATTERN.test(input)) {
    return false
  }
  if (input.includes('.') || input.includes(':')) {
    return false
  }
  return true
}

export function normalizeBrowserNavigationUrl(
  rawUrl: string,
  searchEngine?: SearchEngine | null,
  options: SearchUrlOptions = {}
): string | null {
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0 || trimmed === 'about:blank' || trimmed === ORCA_BROWSER_BLANK_URL) {
    return ORCA_BROWSER_BLANK_URL
  }

  if (LOCAL_ADDRESS_PATTERN.test(trimmed)) {
    try {
      return new URL(`http://${trimmed}`).toString()
    } catch {
      return null
    }
  }

  try {
    const parsed = new URL(trimmed)
    // Why: file:// is allowed so the browser pane can render local files the
    // user already has access to via the editor (e.g. "Open Preview to the
    // Side" on an HTML file). The guest webview is still sandboxed
    // (nodeIntegration off, contextIsolation on, webSecurity on; see
    // createMainWindow.ts will-attach-webview), so the loaded page cannot
    // escalate privileges. Other non-web schemes (javascript:, arbitrary
    // data: URIs) remain rejected.
    return parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'file:'
      ? parsed.toString()
      : null
  } catch {
    // Why: search fallback is opt-in. The main process calls this function for
    // URL validation (will-attach-webview, will-navigate) where non-URL text
    // must be rejected, not converted to a search query. Only the address bar
    // passes a search engine to enable the fallback.
    const searchEnabled = searchEngine !== undefined
    try {
      const withScheme = new URL(`https://${trimmed}`)
      if (!searchEnabled || !looksLikeSearchQuery(trimmed)) {
        return withScheme.toString()
      }
    } catch {
      // Not a valid URL even with https:// prefix
    }

    if (!searchEnabled) {
      return null
    }
    return buildSearchUrl(trimmed, searchEngine ?? DEFAULT_SEARCH_ENGINE, options)
  }
}

export function normalizeExternalBrowserUrl(rawUrl: string): string | null {
  const normalized = normalizeBrowserNavigationUrl(rawUrl)
  if (normalized === null || normalized === ORCA_BROWSER_BLANK_URL) {
    return null
  }
  // Why: external-link opening (shell.openExternal, will-navigate) must only
  // hand off http(s) targets to the OS. file:// is allowed for the in-app
  // browser pane (local HTML preview), but forwarding it to openExternal
  // would let a remote page smuggle arbitrary file paths into Finder/Explorer.
  if (normalized.startsWith('file:')) {
    return null
  }
  return normalized
}
