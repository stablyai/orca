import { useState } from 'react'
import { useAppStore } from '../../../../store/index'
import type { TerminalPaneChatController } from '../../chat/use-terminal-pane-chat-state'

export function useQueuedIssueCommandSplit({ tabId }: Pick<TerminalPaneChatController, 'tabId'>) {
  const [issueCommandSplit] = useState(
    () => useAppStore.getState().pendingIssueCommandSplitByTabId[tabId]
  )
  return { issueCommandSplit }
}
