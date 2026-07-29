import type { TuiAgent } from '../../../../shared/types'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'

export type NativeChatLeafTitlePane = {
  id: number
  leafId: string
}

export type NativeChatLeafTitleAgentInput = {
  leafId: string | null
  panes: readonly NativeChatLeafTitlePane[]
  runtimePaneTitlesByPaneId: Readonly<Record<number, string>>
  tabLabel?: string | null
  terminalTitle?: string | null
}

export function resolveNativeChatLeafTitleAgent({
  leafId,
  panes,
  runtimePaneTitlesByPaneId,
  tabLabel,
  terminalTitle
}: NativeChatLeafTitleAgentInput): TuiAgent | null {
  if (!leafId) {
    return null
  }
  const targetPane = panes.find((pane) => pane.leafId === leafId)
  const paneAgent = targetPane
    ? resolveCommittedTitleAgentType(runtimePaneTitlesByPaneId[targetPane.id] ?? '')
    : null
  if (paneAgent) {
    return paneAgent
  }
  // Tab titles can lag pane focus in split layouts, so use them only when there
  // is no sibling leaf they could accidentally describe.
  if (panes.length > 1) {
    return null
  }
  return (
    resolveCommittedTitleAgentType(tabLabel ?? '') ??
    resolveCommittedTitleAgentType(terminalTitle ?? '')
  )
}
