import { useCallback, useEffect } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { getMeasurablePaneFitDimensions } from '@/lib/pane-manager/terminal-fit/pane-fit-measurability'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import { restoreTerminalFitToDesktop } from './terminal-fit-restore'
import {
  registerRestoredViewportClaimer,
  scheduleRestoredTerminalRefit,
  takeBackAllFromPhone
} from './take-back-all-from-phone'
import type { TerminalPaneContextController } from '../controller/use-terminal-pane-context-actions'

// The host may restore its own baseline, which can still be the phone grid, and this
// pane's refit then has no grid change to send; claim the pane's grid explicitly (#50824).
function claimRemoteViewportAfterTakeBack(
  pane: ManagedPane,
  transport: PtyTransport | undefined,
  restoredPtyIds: ReadonlySet<string>
): void {
  const ptyId = transport?.getPtyId()
  if (!transport || !ptyId || !restoredPtyIds.has(ptyId) || !isRemoteRuntimePtyId(ptyId)) {
    return
  }
  const grid = getMeasurablePaneFitDimensions(pane)
  if (grid) {
    transport.claimViewport?.(grid.cols, grid.rows)
  }
}

export function useMobileTerminalFitActions({
  isVisibleRef,
  managerRef,
  paneTransportsRef,
  refreshMobileOverlays,
  settingsRef
}: Pick<
  TerminalPaneContextController,
  'isVisibleRef' | 'managerRef' | 'paneTransportsRef' | 'refreshMobileOverlays' | 'settingsRef'
>) {
  useEffect(
    () =>
      registerRestoredViewportClaimer((restoredPtyIds) => {
        if (!isVisibleRef.current) {
          return
        }
        for (const pane of managerRef.current?.getPanes() ?? []) {
          claimRemoteViewportAfterTakeBack(
            pane,
            paneTransportsRef.current.get(pane.id),
            restoredPtyIds
          )
        }
      }),
    [isVisibleRef, managerRef, paneTransportsRef]
  )
  const restorePaneTerminalFit = useCallback(
    async (pane: ManagedPane, ptyId: string): Promise<void> => {
      const currentPtyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      if (currentPtyId !== ptyId) {
        refreshMobileOverlays()
        return
      }
      const restored = await restoreTerminalFitToDesktop(ptyId, settingsRef.current ?? undefined)
      if (restored) {
        claimRemoteViewportAfterTakeBack(
          pane,
          paneTransportsRef.current.get(pane.id),
          new Set([ptyId])
        )
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
