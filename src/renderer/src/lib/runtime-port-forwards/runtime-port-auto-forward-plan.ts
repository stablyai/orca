import type { WorkspacePort } from '../../../../shared/workspace-ports'
import {
  RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS,
  type RuntimePortForward,
  type RuntimePortForwardSettings
} from '../../../../shared/runtime-port-forwards'

// A listener must be missing from this many scans in a row before its auto forward closes.
export const AUTO_FORWARD_MISSING_SCANS_BEFORE_CLOSE = 2

export type AutoForwardPlan = {
  open: WorkspacePort[]
  close: RuntimePortForward[]
  /** Remote ports seen in this scan, for the next scan's missing counts. */
  missing: Map<number, number>
}

/** Dev servers a workspace started: attributed to a workspace, in range, and not Orca's own. */
export function isAutoForwardCandidate(
  port: WorkspacePort,
  settings: RuntimePortForwardSettings
): boolean {
  return (
    port.kind === 'workspace' &&
    port.port >= settings.rangeStart &&
    port.port <= settings.rangeEnd &&
    !RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS.has(port.port)
  )
}

/**
 * Decides which listeners of one host to forward and which auto forwards to retire. `attempted`
 * holds ports already tried this session (opened, refused or closed by the user) so they are not retried.
 */
export function planAutoForwards(args: {
  ports: readonly WorkspacePort[]
  forwards: readonly RuntimePortForward[]
  settings: RuntimePortForwardSettings
  attempted: ReadonlySet<number>
  previousMissing: ReadonlyMap<number, number>
}): AutoForwardPlan {
  const { ports, forwards, settings, attempted, previousMissing } = args
  const listening = new Set(ports.map((port) => port.port))
  const candidates = new Set(
    ports.filter((port) => isAutoForwardCandidate(port, settings)).map((port) => port.port)
  )
  const forwarded = new Set(forwards.map((forward) => forward.remotePort))
  const open = settings.autoForward
    ? dedupeByPort(
        ports.filter(
          (port) =>
            isAutoForwardCandidate(port, settings) &&
            !forwarded.has(port.port) &&
            !attempted.has(port.port)
        )
      )
    : []
  const missing = new Map<number, number>()
  const close: RuntimePortForward[] = []
  for (const forward of forwards) {
    // Retire when the server is gone, or when it is no longer a candidate (e.g. Orca's own listener) and idle.
    const keep =
      candidates.has(forward.remotePort) ||
      (listening.has(forward.remotePort) &&
        forward.openConnections > 0 &&
        !RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS.has(forward.remotePort))
    if (forward.reason !== 'auto' || keep) {
      continue
    }
    const count = (previousMissing.get(forward.remotePort) ?? 0) + 1
    if (count >= AUTO_FORWARD_MISSING_SCANS_BEFORE_CLOSE) {
      close.push(forward)
    } else {
      missing.set(forward.remotePort, count)
    }
  }
  return { open, close, missing }
}

// IPv4 and IPv6 binds of one server are two rows for the same port.
function dedupeByPort(ports: WorkspacePort[]): WorkspacePort[] {
  const seen = new Set<number>()
  return ports.filter((port) => {
    if (seen.has(port.port)) {
      return false
    }
    seen.add(port.port)
    return true
  })
}
