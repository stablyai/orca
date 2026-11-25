/** Opens a URL that names a forward's local port in the system browser. The forward is named
 *  because a localhost URL alone cannot say whether a forward or another local app should get it. */
export type ForwardedUrlOpenRequest = {
  url: string
  /** SSH targets and paired servers number their forwards separately. */
  forwardKind: 'ssh' | 'paired'
  connectionId: string
  forwardId: string
  localPort: number
  remoteHost: string
  remotePort: number
}

export type ForwardedUrlOpenResult =
  | { opened: true; url: string; movedToIpv4: boolean }
  | { opened: false }

export function isForwardedUrlOpenRequest(value: unknown): value is ForwardedUrlOpenRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    typeof value.url === 'string' &&
    'forwardKind' in value &&
    (value.forwardKind === 'ssh' || value.forwardKind === 'paired') &&
    'connectionId' in value &&
    typeof value.connectionId === 'string' &&
    'forwardId' in value &&
    typeof value.forwardId === 'string' &&
    'localPort' in value &&
    Number.isInteger(value.localPort) &&
    'remoteHost' in value &&
    typeof value.remoteHost === 'string' &&
    'remotePort' in value &&
    Number.isInteger(value.remotePort)
  )
}
