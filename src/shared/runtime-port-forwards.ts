/** Why a forward exists: the user added it, auto-forward saw a new listener, or SSH access needs it. */
export type RuntimePortForwardReason = 'user' | 'auto' | 'ssh'

/** A host loopback port carried to this computer's localhost over the paired runtime connection. */
export type RuntimePortForward = {
  id: string
  environmentId: string
  remotePort: number
  localPort: number
  reason: RuntimePortForwardReason
  label?: string
  createdAt: number
  /** Connections currently open through this forward. */
  openConnections: number
  totalConnections: number
  bytesToHost: number
  bytesFromHost: number
  /** Last connection failure on the host side (dev server stopped, host asleep), cleared on success. */
  lastError?: string
}

export type RuntimePortForwardFailureCode =
  | 'port_busy'
  | 'listen_failed'
  | 'host_unsupported'
  | 'tunnel_failed'
  | 'invalid_request'

export type RuntimePortForwardOpenRequest = {
  environmentId: string
  remotePort: number
  /** Omit to use the same number (or the next free one unless `exclusive`); 0 picks any free port. */
  localPort?: number
  /** Only ever bind the requested/same port number; fail with `port_busy` instead of choosing another. */
  exclusive?: boolean
  reason: RuntimePortForwardReason
  label?: string
}

export type RuntimePortForwardOpenResult =
  | { ok: true; forward: RuntimePortForward }
  | { ok: false; code: RuntimePortForwardFailureCode; message: string }

/** Settings → Ports. */
export type RuntimePortForwardSettings = {
  /** Forward ports that start listening on a remote host's loopback without asking. */
  autoForward: boolean
  /** Only bind the same port number locally; skip (and say so) when it is taken on this computer. */
  exclusive: boolean
  /** Auto-forward only listeners in this inclusive range. */
  rangeStart: number
  rangeEnd: number
  /** Show a notification when a dev server starts on a remote host. */
  notify: boolean
}

export const DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS: RuntimePortForwardSettings = {
  autoForward: true,
  exclusive: false,
  rangeStart: 1024,
  rangeEnd: 65_535,
  notify: true
}

export function normalizeRuntimePortForwardSettings(
  value: Partial<RuntimePortForwardSettings> | undefined
): RuntimePortForwardSettings {
  const merged = { ...DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS, ...value }
  const clamp = (port: unknown, fallback: number): number =>
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535
      ? port
      : fallback
  const rangeStart = clamp(merged.rangeStart, DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS.rangeStart)
  const rangeEnd = clamp(merged.rangeEnd, DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS.rangeEnd)
  return {
    autoForward: merged.autoForward !== false,
    exclusive: merged.exclusive === true,
    rangeStart: Math.min(rangeStart, rangeEnd),
    rangeEnd: Math.max(rangeStart, rangeEnd),
    notify: merged.notify !== false
  }
}

/** Host ports Orca runs itself (the Orca Cloud VM's sshd); never auto-forwarded or announced. */
export const RUNTIME_PORT_FORWARD_AUTO_EXCLUDED_PORTS: ReadonlySet<number> = new Set([2222, 6768])
