/** Why "Open Remote Desktop" could not open; the renderer words each one. */
export type CloudRemoteDesktopFailureCode =
  /** Not an Orca Cloud workspace, or this build has no control plane. */
  | 'not_cloud'
  /** The workspace is asleep or still starting. */
  | 'not_running'
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
 * noVNC page on the forwarded port. resize=remote makes the VM's screen follow the tab size;
 * reconnect rides out a forward re-dial. The password rides in the fragment, which never goes
 * over HTTP; it differs per VM boot, so a stale tab can never attach to another workspace.
 */
export function cloudRemoteDesktopUrl(localPort: number, path: string, password: string): string {
  const params = new URLSearchParams({
    autoconnect: '1',
    resize: 'remote',
    reconnect: '1',
    reconnect_delay: '1000'
  })
  return `http://localhost:${localPort}/${path}?${params.toString()}#password=${encodeURIComponent(password)}`
}
