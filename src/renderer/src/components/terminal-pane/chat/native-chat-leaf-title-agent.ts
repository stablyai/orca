import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveExplicitTerminalTitleAgentType as resolveCommittedTitleAgentType } from '../../../../../shared/agent-status/title/terminal-title-agent-type'

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
    return isTuiAgent(paneAgent) ? paneAgent : null
  }
  // Use the tab title only without sibling leaves, whose focus it may lag.
  if (panes.length > 1) {
    return null
  }
  const agent =
    resolveCommittedTitleAgentType(tabLabel ?? '') ??
    resolveCommittedTitleAgentType(terminalTitle ?? '')
  return isTuiAgent(agent) ? agent : null
}
