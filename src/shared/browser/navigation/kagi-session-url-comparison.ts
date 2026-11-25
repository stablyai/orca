import { normalizeBrowserNavigationUrl } from './browser-url'

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
  const query = parsed.search.slice(1)
  if (/%(?![0-9A-Fa-f]{2})/.test(query)) {
    return null
  }
  const kept: string[] = []
  for (const parameter of query.split('&')) {
    let name: string
    try {
      // Same name decoding as URLSearchParams, so every spelling of `token` is dropped.
      name = decodeURIComponent(parameter.split('=')[0].replaceAll('+', ' '))
    } catch {
      return null
    }
    if (name !== 'token') {
      kept.push(parameter.replaceAll('%20', '+'))
    }
  }
  parsed.search = kept.length > 0 ? `?${kept.join('&')}` : ''
  return parsed.href
}
