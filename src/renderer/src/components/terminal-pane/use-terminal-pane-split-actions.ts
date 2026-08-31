import { useCallback, useEffect } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { PaneCwdMap } from './resolve-split-cwd'
import {
  REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
  type RequestActiveTerminalPaneSplitDetail
} from '@/constants/terminal'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import { useAppStore } from '@/store'

export function recordContextMenuCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: 'contextual_tour' | 'context_menu'
    direction: 'vertical' | 'horizontal'
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

type UseTerminalPaneSplitActionsDeps = {
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  contextPaneIdRef: React.RefObject<number | null>
  tabId: string
  worktreeId: string
  fallbackCwd: string
  resolveMenuPane: () => ManagedPane | null
}

type TerminalPaneSplitActions = {
  onSplitRight: () => void
  onSplitDown: () => void
}

export function useTerminalPaneSplitActions({
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  contextPaneIdRef,
  tabId,
  worktreeId,
  fallbackCwd,
  resolveMenuPane
}: UseTerminalPaneSplitActionsDeps): TerminalPaneSplitActions {
  const splitWithInheritedCwd = useCallback(
    (
      direction: 'vertical' | 'horizontal',
      source: 'contextual_tour' | 'context_menu' = 'context_menu'
    ): void => {
      const pane = resolveMenuPane()
      const manager = managerRef.current
      if (!pane || !manager) {
        return
      }
      splitTerminalPaneWithInheritedCwd({
        worktreeId,
        tabId,
        manager,
        getManager: () => managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneCwdMap: paneCwdRef.current,
        fallbackCwd,
        pane,
        direction,
        source
      })
    },
    [fallbackCwd, managerRef, paneCwdRef, paneTransportsRef, resolveMenuPane, tabId, worktreeId]
  )

  const onSplitRight = (): void => splitWithInheritedCwd('vertical')
  const onSplitDown = (): void => splitWithInheritedCwd('horizontal')

  useEffect(() => {
    const onRequestSplit = (event: Event): void => {
      const detail = (event as CustomEvent<RequestActiveTerminalPaneSplitDetail>).detail
      if (detail?.tabId && detail.tabId !== tabId) {
        return
      }
      contextPaneIdRef.current = null
      splitWithInheritedCwd(detail?.direction ?? 'vertical', getRequestedSplitTelemetrySource())
    }
    window.addEventListener(REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT, onRequestSplit)
    return () =>
      window.removeEventListener(REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT, onRequestSplit)
    // splitWithInheritedCwd closes over live refs; re-registering keeps the
    // tour action aligned with the current focused pane and fallback cwd.
  }, [tabId, splitWithInheritedCwd, contextPaneIdRef])

  return { onSplitRight, onSplitDown }
}

function getRequestedSplitTelemetrySource(): 'contextual_tour' | 'context_menu' {
  return useAppStore.getState().activeContextualTourId === 'workspace-agent-sessions'
    ? 'contextual_tour'
    : 'context_menu'
}
