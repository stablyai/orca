const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const PRODUCTION_HOSTS = new Set(['app.orca.dev', 'share.orca.dev', 'share.onorca.dev'])

/** A link's share id: a bare id, `orca://<kind>/share/<id>`, or an Orca share page's https URL. */
function parseShareId(value: string, kind: 'skills' | 'bots'): string | null {
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
  const path = new RegExp(`^/?${kind}/share/([A-Za-z0-9_-]{1,128})/?$`)
  if (url.protocol === 'orca:') {
    return `${url.host}${url.pathname}`.match(path)?.[1] ?? null
  }
  const developmentHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(developmentHost && url.protocol === 'http:')) {
    return null
  }
  if (!PRODUCTION_HOSTS.has(url.hostname) && !developmentHost) {
    return null
  }
  return url.pathname.match(path)?.[1] ?? null
}

export const parseSkillShareId = (value: string): string | null => parseShareId(value, 'skills')

export const parseBotShareId = (value: string): string | null => parseShareId(value, 'bots')

/** The share id of a launch argument that is a link, never a bare id. */
function shareIdFromArguments(argv: readonly string[], kind: 'skills' | 'bots'): string | null {
  for (const value of argv) {
    const id = parseShareId(value, kind)
    if (id && (value.includes(`/${kind}/share/`) || value.startsWith('orca:'))) {
      return id
    }
  }
  return null
}

export const skillShareIdFromArguments = (argv: readonly string[]): string | null =>
  shareIdFromArguments(argv, 'skills')

export const botShareIdFromArguments = (argv: readonly string[]): string | null =>
  shareIdFromArguments(argv, 'bots')
