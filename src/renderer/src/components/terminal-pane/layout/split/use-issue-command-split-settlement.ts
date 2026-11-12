import { useEffect } from 'react'
import type { TerminalPaneMountedController } from '../../mounting/use-terminal-pane-lifecycle-stage'

export function useIssueCommandSplitSettlement({
  consumeTabIssueCommandSplit,
  issueCommandSplit,
  tabId,
  terminalManager
}: Pick<
  TerminalPaneMountedController,
  'consumeTabIssueCommandSplit' | 'issueCommandSplit' | 'tabId' | 'terminalManager'
>) {
  useEffect(() => {
    if (terminalManager && issueCommandSplit) {
      consumeTabIssueCommandSplit(tabId)
    }
  }, [terminalManager, issueCommandSplit, tabId, consumeTabIssueCommandSplit])
}
