import { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { restoreTerminalFitToDesktop } from './terminal-fit-restore'
import { scheduleRestoredTerminalRefit, takeBackAllFromPhone } from './take-back-all-from-phone'
import type { TerminalPaneContextController } from '../controller/use-terminal-pane-context-actions'

export function useMobileTerminalFitActions({
  paneTransportsRef,
  refreshMobileOverlays,
  settingsRef
}: Pick<
  TerminalPaneContextController,
  'paneTransportsRef' | 'refreshMobileOverlays' | 'settingsRef'
>) {
  const restorePaneTerminalFit = useCallback(
    async (pane: ManagedPane, ptyId: string): Promise<void> => {
      const currentPtyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      if (currentPtyId !== ptyId) {
        refreshMobileOverlays()
        return
      }
      const restored = await restoreTerminalFitToDesktop(ptyId, settingsRef.current ?? undefined)
      if (restored) {
        scheduleRestoredTerminalRefit()
        pane.terminal.focus()
      }
    },
    [refreshMobileOverlays, paneTransportsRef, settingsRef]
  )
  const restoreAllTerminalFits = useCallback(
    async (focusPane: ManagedPane, phoneIsDriving: boolean): Promise<void> => {
      const { terminalsRestored } = await takeBackAllFromPhone(settingsRef.current ?? undefined, {
        // Why: held-fit "Restore all" only resizes; it must not cut a phone still browsing.
        includeBrowserPages: phoneIsDriving
      })
      if (terminalsRestored) {
        focusPane.terminal.focus()
      }
    },
    [settingsRef]
  )
  return { restorePaneTerminalFit, restoreAllTerminalFits }
}
