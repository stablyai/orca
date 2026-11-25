import { normalizeBrowserNavigationUrl } from './browser-url'
import { kagiQueryWithoutToken } from './kagi-token-query'

/**
 * A Kagi URL without its token, for comparing addresses: every other query byte stays as written,
 * except that `%20` and `+` (the two spellings of a space) compare alike. Null when the query has
 * an escape that cannot be decoded, so a caller can fail closed instead of guessing.
 */
export function comparableKagiSessionUrl(rawUrl: string): string | null {
  if (!rawUrl.includes('?')) {
    return rawUrl
  }
  let parsed: URL
  try {
    parsed = new URL(normalizeBrowserNavigationUrl(rawUrl) ?? rawUrl)
  } catch {
    return rawUrl
  }
  const hostname = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || (hostname !== 'kagi.com' && hostname !== 'www.kagi.com')) {
    return rawUrl
  }
  const kept = kagiQueryWithoutToken(parsed.search)
  if (kept === null) {
    return null
  }
  const comparable = kept.replaceAll('%20', '+')
  // Assigning '' would drop an explicit empty `?`; only a removed token may empty the query.
  if (comparable !== parsed.search) {
    parsed.search = comparable
  }
  return parsed.href
}
