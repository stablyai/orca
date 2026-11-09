import { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { getMobileFitOverridePtyIds } from '@/lib/pane-manager/mobile-fit-overrides'
import { getAllDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'
import type { TerminalPaneContextController } from '../controller/use-terminal-pane-context-actions'

export function useMobileTerminalFitActions({
  paneTransportsRef,
  refreshMobileOverlays,
  settingsRef
}: Pick<
  TerminalPaneContextController,
  'paneTransportsRef' | 'refreshMobileOverlays' | 'settingsRef'
>) {
  const getMobileOwnedTerminalPtyIds = useCallback((): string[] => {
    const ptyIds = new Set(getMobileFitOverridePtyIds())
    for (const [ptyId, driver] of getAllDrivers()) {
      if (driver.kind === 'mobile') {
        ptyIds.add(ptyId)
      }
    }
    return [...ptyIds]
  }, [])
  const scheduleRestoredTerminalRefit = useCallback((): void => {
    requestAnimationFrame(refitAndRefreshAllTerminalPanes)
    window.setTimeout(refitAndRefreshAllTerminalPanes, 100)
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
      const restored = await restoreTerminalFitsToDesktop(
        getMobileOwnedTerminalPtyIds(),
        settingsRef.current ?? undefined
      )
      if (restored) {
        scheduleRestoredTerminalRefit()
        focusPane.terminal.focus()
      }
    },
    [getMobileOwnedTerminalPtyIds, scheduleRestoredTerminalRefit, settingsRef]
  )
  return {
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits
  }
}
