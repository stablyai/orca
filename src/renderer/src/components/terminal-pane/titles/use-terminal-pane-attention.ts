import { useCallback, useLayoutEffect } from 'react'
import {
  applyTerminalPaneAttentionToManager,
  subscribeTerminalPaneAttention
} from './terminal-pane-attention-subscriptions'
import type { TerminalPaneMountedController } from '../mounting/use-terminal-pane-lifecycle-stage'

export function useTerminalPaneAttention({
  managerRef,
  terminalManager,
  paneCount,
  tabId
}: Pick<
  TerminalPaneMountedController,
  'managerRef' | 'terminalManager' | 'paneCount' | 'tabId'
>): void {
  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (terminalManager && manager === terminalManager) {
      applyTerminalPaneAttentionToManager(manager, tabId)
    }
  }, [tabId, managerRef, terminalManager])
  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])
}
