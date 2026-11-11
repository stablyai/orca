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
  return `http://localhost:${localPort}/${path}?${DESKTOP_QUERY}`
}

const DESKTOP_QUERY = new URLSearchParams({
  autoconnect: '0',
  reconnect: '0',
  resize: 'remote'
}).toString()

/**
 * True for a page URL shaped like cloudRemoteDesktopUrl, whether or not this computer still
 * forwards its port. For presentation and reconnects only (tab icon, chrome, asleep state): main
 * alone decides which page gets tickets (remote-desktop-sessions.ts).
 */
export function isCloudRemoteDesktopUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
    parsed.port !== '' &&
    /^\/[\w.-]+\.html$/.test(parsed.pathname) &&
    parsed.search.slice(1) === DESKTOP_QUERY &&
    parsed.hash === ''
  )
}

/**
 * How a desktop page stands with main: `none` = no session for it on this computer (a tab restored
 * after a restart, or its forward closed when the sandbox slept), then connecting, connected, or
 * paused (main stopped retrying; `reason` says why).
 */
export type RemoteDesktopConnection = 'none' | 'connecting' | 'connected' | 'paused'

export type RemoteDesktopPauseReason =
  | 'asleep'
  | 'archived'
  | 'starting'
  | 'signed_out'
  | 'unavailable'
  | 'failed'

/** Main → renderer, per browser page shaped like a remote desktop (and for a page that stops being one). */
export type RemoteDesktopPageState = {
  browserPageId: string
  /** The page is a remote desktop with a live session: it gets tickets and keeps the keyboard. */
  desktop: boolean
  /** It has keyboard focus: Orca's shortcuts are off until the release chord. */
  captured: boolean
  connection: RemoteDesktopConnection
  /** Set while paused. */
  reason?: RemoteDesktopPauseReason
}
