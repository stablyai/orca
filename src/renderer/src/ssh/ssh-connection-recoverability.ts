import type { SshConnectionStatus } from '../../../shared/ssh-types'

// Total Record makes new statuses typecheck failures; includes() would silently leave new recoverable states with dead controls.
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

export function canConnectSshStatus(status: SshConnectionStatus | null | undefined): boolean {
  return status ? CAN_CONNECT_BY_STATUS[status] : false
}
