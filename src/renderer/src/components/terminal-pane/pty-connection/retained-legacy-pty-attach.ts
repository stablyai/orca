import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindAttachRetainedLegacyPty(session: ConnectPanePtySession): void {
  session.attachRetainedLegacyPty = (ptyId: string): boolean => {
    try {
      session.authoritativeReattachGeneration += 1
      session.clearPaneMode2031State()
      session.clearHiddenOutputRestoreState()
      const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError, null)
      const remoteAttach = isRemoteRuntimePtyId(ptyId)
      let remoteAttachPending = remoteAttach
      const settleRemoteAttach = (discardPending: boolean): void => {
        if (
          !remoteAttachPending ||
          session.disposed ||
          outputCallbacks.generation !== session.transportStreamGeneration ||
          session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
        ) {
          return
        }
        remoteAttachPending = false
        if (discardPending) {
          session.kittyShortcutInputSettlement.settleDiscardingPending(
            session.kittyKeyboardModes.flags
          )
        } else {
          session.kittyShortcutInputSettlement.settle(session.kittyKeyboardModes.flags)
        }
      }
      const baseCallbacks = outputCallbacks.callbacks
      session.transport.attach({
        existingPtyId: ptyId,
        callbacks: remoteAttach
          ? {
              ...baseCallbacks,
              onConnect: () => {
                baseCallbacks.onConnect?.()
                settleRemoteAttach(false)
              },
              onError: (message: string, errors?: string[]) => {
                settleRemoteAttach(true)
                baseCallbacks.onError?.(message, errors)
              },
              onDisconnect: () => {
                settleRemoteAttach(true)
                baseCallbacks.onDisconnect?.()
              }
            }
          : baseCallbacks
      })
      const attachedPtyId = session.transport.getPtyId() ?? ptyId
      session.bindActivePanePty(attachedPtyId, {
        updateTabPtyId: 'if-missing',
        sampleVisibleForegroundAgent: true
      })
      if (isRemoteRuntimePtyId(attachedPtyId)) {
        session.registerPaneSerializerFor(attachedPtyId)
      }
      if (!remoteAttach) {
        session.kittyShortcutInputSettlement.settle(session.kittyKeyboardModes.flags)
      }
      return true
    } catch (err) {
      session.kittyShortcutInputSettlement.settleDiscardingPending(session.kittyKeyboardModes.flags)
      session.reportError(err instanceof Error ? err.message : String(err))
      return false
    }
  }
}
