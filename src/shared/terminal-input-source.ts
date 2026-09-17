// Why: the runtime already knows which paired device wrote into a PTY (RpcContext carries
// pairedDeviceId and clientKind), but nothing kept it. Agent hooks only see launch-time env,
// so this is the one record they can read back to learn where the user is typing from.

export type TerminalInputSourceClientKind = 'mobile' | 'runtime' | 'local'

export type TerminalInputSource = {
  /** Paired device that sent the input; null for in-process (desktop renderer) input. */
  pairedDeviceId: string | null
  /** Device name from the pairing registry, resolved at read time; null when unknown. */
  deviceName: string | null
  clientKind: TerminalInputSourceClientKind
  /** Milliseconds since epoch when the input was accepted by the PTY. */
  at: number
}

/** Caller identity as an RPC handler sees it; both fields are absent for in-process callers. */
export type TerminalInputCaller = {
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
}

const ROUTE_PREFIX = '/pane/'
const ROUTE_SUFFIX = '/last-input'

export function buildTerminalInputSourcePath(paneKey: string): string {
  return `${ROUTE_PREFIX}${encodeURIComponent(paneKey)}${ROUTE_SUFFIX}`
}

/** Returns the pane key from `/pane/<paneKey>/last-input`, or null for any other path. */
export function parseTerminalInputSourcePath(pathname: string): string | null {
  if (!pathname.startsWith(ROUTE_PREFIX) || !pathname.endsWith(ROUTE_SUFFIX)) {
    return null
  }
  const encoded = pathname.slice(ROUTE_PREFIX.length, pathname.length - ROUTE_SUFFIX.length)
  if (!encoded || encoded.includes('/')) {
    return null
  }
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}
