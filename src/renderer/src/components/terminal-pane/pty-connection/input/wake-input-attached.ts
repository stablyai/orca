// When a pane's held wake typing may go in (wake-input-buffer): the pane is attached to the woken
// terminal. "Connected" alone is not enough: a transport whose PTY is not attached yet, or whose
// connect is still pending, could take the keys and lose them (PAIRED-WAKE-TYPE-THROUGH).

export type WakeInputTransport = {
  isConnected: () => boolean
  getPtyId: () => string | null | undefined
  getRecoveryState?: () => { phase?: string } | null | undefined
  isConnectPending?: () => boolean
  hasUndeliveredInput?: () => boolean
}

export function isAttachedForWakeInput(transport: WakeInputTransport | null | undefined): boolean {
  if (!transport) {
    return false
  }
  const phase = transport.getRecoveryState?.()?.phase
  return Boolean(
    transport.isConnected() &&
    (phase ?? 'connected') === 'connected' &&
    transport.getPtyId() &&
    transport.isConnectPending?.() !== true &&
    transport.hasUndeliveredInput?.() !== true
  )
}
