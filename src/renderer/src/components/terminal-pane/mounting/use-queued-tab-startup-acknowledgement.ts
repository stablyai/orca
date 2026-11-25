import { useCallback } from 'react'
import type { TerminalPaneStoreController } from '../controller/use-terminal-pane-store-bindings'

export function useQueuedTabStartupAcknowledgement({
  consumeTabStartupCommand,
  startup,
  tabId
}: Pick<TerminalPaneStoreController, 'consumeTabStartupCommand' | 'startup' | 'tabId'>) {
  const settleTabStartupCommand = useCallback(() => {
    if (startup) {
      consumeTabStartupCommand(tabId, startup)
    }
  }, [consumeTabStartupCommand, startup, tabId])
  return { settleTabStartupCommand }
}
