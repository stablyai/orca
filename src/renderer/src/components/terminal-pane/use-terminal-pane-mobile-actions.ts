import React, { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { getMobileFitOverridePtyIds } from '@/lib/pane-manager/mobile-fit-overrides'
import { getAllDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'
import {
  armPrimarySelectionNativePasteSuppression,
  isPrimarySelectionEnabled,
  readPrimarySelectionText
} from '@/lib/primary-selection'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import type { TerminalPaneContextController } from './use-terminal-pane-context-actions'

// Match xterm’s forced selection: Shift (Option on Mac) withholds TUI mouse reports, leaving Orca to paste.
function terminalForcesSelectionForClick(event: React.MouseEvent): boolean {
  return navigator.userAgent.includes('Mac') ? event.altKey : event.shiftKey
}

export function useTerminalPaneMobileActions(controller: TerminalPaneContextController) {
  const {
    cwd,
    managerRef,
    paneCwdRef,
    paneTransportsRef,
    refreshMobileOverlays,
    setTerminalError,
    settingsRef,
    tabId,
    worktreeId
  } = controller
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
  const terminalShouldHandleMiddleClick = useCallback(
    (target: EventTarget | null): target is Node => {
      if (!(target instanceof Element)) {
        return false
      }
      if (target.closest('[data-terminal-search-root]')) {
        return false
      }
      const editable = target.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"]'
      )
      return !editable || editable.classList.contains('xterm-helper-textarea')
    },
    []
  )
  // Suppress native paste even when the TUI owns PRIMARY paste, or Chromium inserts it twice (#21762).
  const findTerminalPaneForMiddleClick = useCallback(
    (target: EventTarget | null) => {
      if (!terminalShouldHandleMiddleClick(target)) {
        return null
      }
      const manager = managerRef.current
      if (!manager) {
        return null
      }
      return (
        manager.getPanes().find((pane) => pane.container.contains(target as Node)) ??
        manager.getActivePane() ??
        manager.getPanes()[0] ??
        null
      )
    },
    [terminalShouldHandleMiddleClick, managerRef]
  )
  const handlePrimarySelectionMiddleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 1 || !isPrimarySelectionEnabled()) {
        return
      }
      const targetPane = findTerminalPaneForMiddleClick(event.target)
      if (!targetPane) {
        return
      }
      // Always arm suppression for Chromium’s mouseup paste; forward tracking-mode reports unless the selection modifier makes Orca the sole paste owner.
      event.preventDefault()
      armPrimarySelectionNativePasteSuppression()
      if (
        targetPane.terminal.modes.mouseTrackingMode !== 'none' &&
        !terminalForcesSelectionForClick(event)
      ) {
        return
      }
      const clickedPane = targetPane
      event.stopPropagation()
      clickedPane.terminal.focus()
      void readPrimarySelectionText().then(async (text) => {
        if (!text) {
          return
        }
        const transport = paneTransportsRef.current.get(clickedPane.id)
        const ptyId = transport?.getPtyId() ?? null
        const targetStillMounted = (): boolean =>
          isTerminalPanePasteTargetCurrent({
            manager: managerRef.current,
            paneTransports: paneTransportsRef.current,
            paneId: clickedPane.id,
            leafId: clickedPane.leafId,
            transport,
            ptyId
          })
        const execution = await pasteTextIntoTerminalPane({
          pane: clickedPane,
          text,
          source: 'middle-click',
          ptyId,
          runtime: resolveTerminalPasteRuntime({
            platform: getShortcutPlatform(),
            ptyId,
            transport
          }),
          transport,
          inputKind: 'driving',
          isTargetCurrent: targetStillMounted,
          canContinue: targetStillMounted
        })
        if (execution.status !== 'pasted') {
          setTerminalError(formatTerminalPasteExecutionError(execution.reason))
          return
        }
        recordTerminalUserInputForLeaf(tabId, clickedPane.leafId)
      })
    },
    [findTerminalPaneForMiddleClick, tabId, managerRef, paneTransportsRef, setTerminalError]
  )
  const handlePrimarySelectionAuxClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 1 || !isPrimarySelectionEnabled()) {
        return
      }
      const targetPane = findTerminalPaneForMiddleClick(event.target)
      if (!targetPane) {
        return
      }
      event.preventDefault()
      armPrimarySelectionNativePasteSuppression()
      if (
        targetPane.terminal.modes.mouseTrackingMode === 'none' ||
        terminalForcesSelectionForClick(event)
      ) {
        event.stopPropagation()
      }
    },
    [findTerminalPaneForMiddleClick]
  )
  const activatePaneTitleInteraction = useCallback(
    (paneId: number): void => {
      managerRef.current?.setActivePane(paneId, { focus: false })
    },
    [managerRef]
  )
  const splitTerminalPaneFromHeader = useCallback(
    (pane: ManagedPane, direction: 'vertical' | 'horizontal') => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      splitTerminalPaneWithInheritedCwd({
        worktreeId,
        tabId,
        manager,
        getManager: () => managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneCwdMap: paneCwdRef.current,
        fallbackCwd: cwd ?? '',
        pane,
        direction,
        source: 'context_menu'
      })
    },
    [cwd, managerRef, paneCwdRef, paneTransportsRef, tabId, worktreeId]
  )
  const beginPaneDragFromHeader = useCallback(
    (paneId: number, handle: HTMLElement, event: PointerEvent) => {
      managerRef.current?.beginPaneDragFromPointerDown(paneId, handle, event)
    },
    [managerRef]
  )

  return {
    getMobileOwnedTerminalPtyIds,
    scheduleRestoredTerminalRefit,
    restorePaneTerminalFit,
    restoreAllTerminalFits,
    terminalShouldHandleMiddleClick,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick,
    activatePaneTitleInteraction,
    splitTerminalPaneFromHeader,
    beginPaneDragFromHeader
  }
}

export type TerminalPaneMobileController = TerminalPaneContextController &
  ReturnType<typeof useTerminalPaneMobileActions>
