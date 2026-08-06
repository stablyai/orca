import type { SshConnectionStatus } from '../../../shared/ssh-types'

// Why: a total Record makes a new SshConnectionStatus member a typecheck failure. An
// array + .includes() would silently classify it as "not recoverable", leaving its cards
// with a dead glyph and no way to reconnect.
const CONNECTING_BY_STATUS: Record<SshConnectionStatus, boolean> = {
  disconnected: false,
  connecting: true,
  'auth-failed': false,
  'deploying-relay': true,
  connected: false,
  reconnecting: true,
  'reconnection-failed': false,
  error: false
}

const CAN_CONNECT_BY_STATUS: Record<SshConnectionStatus, boolean> = {
  disconnected: true,
  connecting: false,
  'auth-failed': true,
  'deploying-relay': false,
  connected: false,
  reconnecting: false,
  'reconnection-failed': true,
  error: true
}

/** Relay deployment and reconnect are host-driven transients: no user action helps yet. */
export function isConnectingSshStatus(status: SshConnectionStatus | null | undefined): boolean {
  return status ? CONNECTING_BY_STATUS[status] : false
}

/** Failure states a user-initiated connect can recover from. */
export function canConnectSshStatus(status: SshConnectionStatus | null | undefined): boolean {
  return status ? CAN_CONNECT_BY_STATUS[status] : false
}
