// Retain diagnostics for v1.4.225–v1.4.228 hosts that refuse cross-machine plain-HTTP pairing with this code.
export const INSECURE_WEB_ORIGIN_AUTH_CODE = 'insecure_origin' as const

// React Native also sends HTTP LAN Origins; only the web upgrade marker distinguishes browsers. Hosts ignore the query, preserving compatibility.
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
