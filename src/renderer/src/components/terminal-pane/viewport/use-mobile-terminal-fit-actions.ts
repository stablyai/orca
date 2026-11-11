import { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  getMobileOwnedTerminalPtyIds as readMobileOwnedTerminalPtyIds,
  reclaimAllMobileSurfacesToDesktop,
  restoreTerminalFitToDesktop,
  scheduleRestoredTerminalRefit as triggerRestoredTerminalRefit
} from './terminal-fit-restore'
import type { TerminalPaneContextController } from '../controller/use-terminal-pane-context-actions'

export function useMobileTerminalFitActions({
  paneTransportsRef,
  refreshMobileOverlays,
  settingsRef
}: Pick<
  TerminalPaneContextController,
  'paneTransportsRef' | 'refreshMobileOverlays' | 'settingsRef'
>) {
  const getMobileOwnedTerminalPtyIds = useCallback(
    (): string[] => readMobileOwnedTerminalPtyIds(),
    []
  )
  const scheduleRestoredTerminalRefit = useCallback((): void => {
    triggerRestoredTerminalRefit()
  }, [])
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
    [refreshMobileOverlays, scheduleRestoredTerminalRefit, paneTransportsRef, settingsRef]
  )
  const restoreAllTerminalFits = useCallback(
    async (focusPane: ManagedPane): Promise<void> => {
      const { restored, hadTargets } = await reclaimAllMobileSurfacesToDesktop(
        settingsRef.current ?? undefined
      )
      if (restored || hadTargets) {
        scheduleRestoredTerminalRefit()
      }
      if (restored) {
        focusPane.terminal.focus()
      }
    },
    [scheduleRestoredTerminalRefit, settingsRef]
  )
  return {
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits
  }
}
