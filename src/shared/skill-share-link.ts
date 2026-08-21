const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const PRODUCTION_HOSTS = new Set(['app.orca.dev', 'share.onorca.dev'])

export function parseSkillShareId(value: string): string | null {
  const trimmed = value.trim()
  if (SHARE_ID_PATTERN.test(trimmed)) {
    return trimmed
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol === 'orca:') {
    const match = `${url.host}${url.pathname}`.match(/^skills\/share\/([A-Za-z0-9_-]{1,128})\/?$/)
    return match?.[1] ?? null
  }
  const developmentHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(developmentHost && url.protocol === 'http:')) {
    return null
  }
  if (!PRODUCTION_HOSTS.has(url.hostname) && !developmentHost) {
    return null
  }
  const match = url.pathname.match(/^\/skills\/share\/([A-Za-z0-9_-]{1,128})\/?$/)
  return match?.[1] ?? null
}

export function skillShareIdFromArguments(argv: readonly string[]): string | null {
  for (const value of argv) {
    const id = parseSkillShareId(value)
    if (id && (value.includes('/skills/share/') || value.startsWith('orca:'))) {
      return id
    }
  }
  return null
}
