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
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const request = value as Record<string, unknown>
  return (
    typeof request.url === 'string' &&
    (request.forwardKind === 'ssh' || request.forwardKind === 'paired') &&
    typeof request.connectionId === 'string' &&
    typeof request.forwardId === 'string' &&
    Number.isInteger(request.localPort) &&
    typeof request.remoteHost === 'string' &&
    Number.isInteger(request.remotePort)
  )
}
