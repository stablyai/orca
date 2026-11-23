import { isConnectorAvatarUrl } from './connector-message-asker'

/** A connector asker's picture, fetched once by the desktop and served from its cache. */
export const CONNECTOR_AVATAR_SCHEME = 'orca-connector-avatar'
const PREFIX = `${CONNECTOR_AVATAR_SCHEME}://image/`

function base64Url(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return null
  }
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0))
    )
  } catch {
    return null
  }
}

export function connectorAvatarSrc(avatarUrl: string): string {
  return `${PREFIX}${base64Url(avatarUrl)}`
}

/** The avatar URL a src names; null unless it is one a connector's avatar may come from. */
export function connectorAvatarUrlOf(src: string): string | null {
  if (!src.startsWith(PREFIX)) {
    return null
  }
  const url = fromBase64Url(src.slice(PREFIX.length))
  return url !== null && isConnectorAvatarUrl(url) ? url : null
}
