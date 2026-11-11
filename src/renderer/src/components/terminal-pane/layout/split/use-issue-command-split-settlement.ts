import { useEffect } from 'react'
import type { TerminalPaneStoreController } from '../../controller/use-terminal-pane-store-bindings'

export function useIssueCommandSplitSettlement({
  consumeTabIssueCommandSplit,
  issueCommandSplit,
  tabId
}: Pick<
  TerminalPaneStoreController,
  'consumeTabIssueCommandSplit' | 'issueCommandSplit' | 'tabId'
>) {
  useEffect(() => {
    if (issueCommandSplit) {
      consumeTabIssueCommandSplit(tabId)
    }
  }, [issueCommandSplit, tabId, consumeTabIssueCommandSplit])
}
