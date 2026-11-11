import { useCallback, useLayoutEffect } from 'react'
import {
  applyTerminalPaneAttentionToManager,
  subscribeTerminalPaneAttention
} from './terminal-pane-attention-subscriptions'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useTerminalPaneAttention({
  managerRef,
  paneCount,
  tabId
}: Pick<TerminalPaneCloseController, 'managerRef' | 'paneCount' | 'tabId'>): void {
  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (manager) {
      applyTerminalPaneAttentionToManager(manager, tabId)
    }
  }, [tabId, managerRef])
  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])
}
