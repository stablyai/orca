/** A remote host asked this desktop to open a URL; the owner approves it by `requestId`. */
export type RemoteOpenUrlRequestEvent = {
  requestId: string
  url: string
  sshTargetId: string
  /** Set when the page will send the browser back to a loopback port on the remote host. */
  callbackPort: number | null
}

export type RemoteOpenUrlApprovalResult =
  | { status: 'opened'; forwardedPort: number | null; forwardMinutes: number | null }
  | { status: 'expired' }
  | { status: 'forward_failed'; reason: 'port_in_use' | 'unavailable'; port: number }
