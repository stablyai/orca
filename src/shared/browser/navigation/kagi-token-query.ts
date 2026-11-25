/**
 * A URL's `search` (leading `?` included) without its `token` parameters, every other byte as
 * written. Null when the query has an escape that cannot be decoded, so callers fall back to a
 * safe path instead of guessing which parameter is the token.
 */
export function kagiQueryWithoutToken(search: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (query === '') {
    return search
  }
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
      kept.push(parameter)
    }
  }
  return kept.length > 0 ? `?${kept.join('&')}` : ''
}
