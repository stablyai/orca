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
import { getConnectionId } from '@/lib/connection-context'
import { executeTerminalPastePlan, planTerminalPasteWithYield } from './terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import type { TerminalPaneContextController } from './use-terminal-pane-context-actions'

// Why: mirrors xterm's SelectionService.shouldForceSelection — a shifted click
// (Option-click on Mac, via macOptionClickForcesSelection) is never forwarded
// as a mouse report, so the TUI cannot paste and Orca must own it instead.
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [refreshMobileOverlays, scheduleRestoredTerminalRefit]
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [getMobileOwnedTerminalPtyIds, scheduleRestoredTerminalRefit]
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
  // Why: any terminal pane target must arm native-paste suppression, even one
  // in mouse-tracking mode where the TUI (not Orca) owns the click and performs
  // its own PRIMARY paste from the forwarded mouse report — otherwise
  // Chromium's unsuppressed native paste lands on top of it (#21762).
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [terminalShouldHandleMiddleClick]
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
      // Why: arm the shared suppression window unconditionally — it, not
      // preventDefault, is what swallows Chromium's native follow-up paste
      // (fired on mouseup, not mousedown; see usePrimarySelectionPaste.ts).
      // Only the paste-to-PTY below is gated on tracking mode, since a
      // tracking TUI still needs the click forwarded as a mouse report and
      // must not have propagation stopped — unless the modifier makes xterm
      // withhold the report, in which case nobody else will paste.
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
        const isMac = navigator.userAgent.includes('Mac')
        const shortcutPlatform: NodeJS.Platform = isMac
          ? 'darwin'
          : navigator.userAgent.includes('Windows')
            ? 'win32'
            : 'linux'
        const connectionId = getConnectionId(worktreeId) ?? null
        const targetStillMounted = (): boolean => {
          const manager = managerRef.current
          return Boolean(
            manager
              ?.getPanes()
              .some(
                (livePane) =>
                  livePane.id === clickedPane.id && livePane.leafId === clickedPane.leafId
              ) &&
            transport &&
            paneTransportsRef.current.get(clickedPane.id) === transport &&
            transport.isConnected() &&
            transport.getPtyId() === ptyId
          )
        }
        const plan = await planTerminalPasteWithYield({
          text,
          source: 'middle-click',
          target: {
            kind: 'terminal',
            paneId: clickedPane.id,
            leafId: clickedPane.leafId,
            ptyId,
            runtime: resolveTerminalPasteRuntime({
              platform: shortcutPlatform,
              ptyId,
              connectionId,
              remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
              transport
            })
          },
          terminalBracketedPasteMode: clickedPane.terminal.modes.bracketedPasteMode
        })
        const execution = await executeTerminalPastePlan(plan, {
          pasteText: (pasteText, pasteOptions) =>
            pasteTerminalText(clickedPane.terminal, pasteText, pasteOptions),
          writePty: (data) => writeTerminalPastePtyInput(transport, data, 'driving'),
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [findTerminalPaneForMiddleClick, tabId, worktreeId]
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
  const activatePaneTitleInteraction = useCallback((paneId: number): void => {
    managerRef.current?.setActivePane(paneId, { focus: false })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [cwd]
  )
  const beginPaneDragFromHeader = useCallback(
    (paneId: number, handle: HTMLElement, event: PointerEvent) => {
      managerRef.current?.beginPaneDragFromPointerDown(paneId, handle, event)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    []
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
