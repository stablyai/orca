/** The mobile shell shares the web bundle but lives at `/remote` (also under a proxy prefix). */
export const MOBILE_REMOTE_PATH = '/remote'

export function isMobileRemotePath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return (
    normalized === MOBILE_REMOTE_PATH || normalized.endsWith(MOBILE_REMOTE_PATH)
  )
}

export type MobileRemoteHashParams = {
  /** The pairing offer or one-time token carried in the URL fragment. */
  pairingInput: string | null
  hostName: string | null
}

/**
 * Read the fragment without ever sending it to a proxy. Both the current
 * `#pairing=<offer>` shape and the older `#token=<token>` shape are accepted.
 */
export function parseMobileRemoteHash(hash: string): MobileRemoteHashParams {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  return {
    pairingInput: params.get('pairing') ?? params.get('token'),
    hostName: params.get('name')
  }
}
