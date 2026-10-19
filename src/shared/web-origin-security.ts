// Why kept: hosts from v1.4.225 to v1.4.228 refuse a first pairing from a plain-http page on another
// machine with this sealed code, and the browser still explains it when paired to one.
export const INSECURE_WEB_ORIGIN_AUTH_CODE = 'insecure_origin' as const

// Why a marker: React Native phones also send an http Origin on LAN sockets, so the Origin alone
// cannot say "browser". Only the web bundle adds this query to its upgrade URL; hosts ignore the
// query string, so the marked upgrade connects to every host.
export const WEB_CLIENT_UPGRADE_PARAM = 'orca-client' as const
export const WEB_CLIENT_UPGRADE_VALUE = 'web' as const

export function withWebClientUpgradeMarker(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    url.searchParams.set(WEB_CLIENT_UPGRADE_PARAM, WEB_CLIENT_UPGRADE_VALUE)
    return url.toString()
  } catch {
    return endpoint
  }
}
