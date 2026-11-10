/** Why "Open Remote Desktop" could not open; the renderer words each one. */
export type CloudRemoteDesktopFailureCode =
  /** Not an Orca Cloud workspace, or this build has no control plane. */
  | 'not_cloud'
  /** The sandbox is asleep: waking it is the next step. */
  | 'not_running'
  /** The workspace is archived: unarchive it first. */
  | 'archived'
  /** The sandbox is starting or waking: try again in a moment. */
  | 'starting'
  /** The workspace's image predates the remote desktop. */
  | 'not_installed'
  | 'signed_out'
  /** Orca Cloud, the VM or the plan refused or did not answer. */
  | 'unavailable'
  /** The desktop started but this computer could not forward its port. */
  | 'forward_failed'

export type CloudRemoteDesktopResult =
  | { ok: true; url: string; localPort: number }
  | { ok: false; code: CloudRemoteDesktopFailureCode }

/**
 * noVNC page on the forwarded port. It holds no secret: Orca hands the page a single-use ticket
 * for each WebSocket after it loads (and again for a reconnect), so the URL can be shown, kept in
 * the tab and restored. resize=remote makes the VM's screen follow the tab size; noVNC's own
 * connect and reconnect are off because each attempt needs a ticket from Orca.
 */
export function cloudRemoteDesktopUrl(localPort: number, path: string): string {
  const params = new URLSearchParams({ autoconnect: '0', reconnect: '0', resize: 'remote' })
  return `http://localhost:${localPort}/${path}?${params.toString()}`
}
