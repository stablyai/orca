import React, { useCallback } from 'react'
import {
  armPrimarySelectionNativePasteSuppression,
  isPrimarySelectionEnabled,
  readPrimarySelectionText
} from '@/lib/primary-selection'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { resolveTerminalPasteRuntime } from '../paste/terminal-paste-runtime'
import { isTerminalPanePasteTargetCurrent } from '../paste/terminal-paste-target-state'
import { pasteTextIntoTerminalPane } from '../paste/terminal-pane-paste-dispatch'
import { formatTerminalPasteExecutionError } from '../paste/terminal-paste-errors'
import { recordTerminalUserInputForLeaf } from '../terminal-input-activity'
import type { TerminalPaneContextController } from '../../controller/use-terminal-pane-context-actions'

function terminalForcesSelectionForClick(event: React.MouseEvent): boolean {
  return navigator.userAgent.includes('Mac') ? event.altKey : event.shiftKey
}

export function useTerminalPrimarySelectionActions({
  managerRef,
  paneTransportsRef,
  setTerminalError,
  tabId
}: Pick<
  TerminalPaneContextController,
  'managerRef' | 'paneTransportsRef' | 'setTerminalError' | 'tabId'
>) {
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
  return {
    terminalShouldHandleMiddleClick,
    handlePrimarySelectionMiddleMouseDown,
    handlePrimarySelectionAuxClick
  }
}
