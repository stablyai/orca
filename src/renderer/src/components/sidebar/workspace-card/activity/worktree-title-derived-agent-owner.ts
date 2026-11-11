import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { resolvePaneAgentOwner } from '../../../../../../shared/agent-status/identity/pane-agent-owner'
import { isTerminalLeafId } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'

export function resolveLaunchAgentOwnerLeafId(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  layoutLeafIds: readonly string[]
): string | null {
  const layoutActiveLeafId = layout?.activeLeafId
  const layoutOwnerLeafId =
    layoutLeafIds.length === 1
      ? layoutLeafIds[0]
      : layoutLeafIds.length === 0 && layoutActiveLeafId && isTerminalLeafId(layoutActiveLeafId)
        ? layoutActiveLeafId
        : null
  const retainedLaunchAgentLeafId =
    tab.launchAgentLeafId && isTerminalLeafId(tab.launchAgentLeafId) ? tab.launchAgentLeafId : null
  return layoutOwnerLeafId ?? retainedLaunchAgentLeafId
}

export function resolveTitleDerivedPaneOwner(args: {
  tab: TerminalTab
  layout: TerminalLayoutSnapshot | undefined
  layoutLeafIds: readonly string[]
  leafId: string
}): AgentType | null {
  // Why: a tab-wide launch hint may be the only owner evidence while layout is unhydrated; in a split it still brands only its retained leaf.
  if (resolveLaunchAgentOwnerLeafId(args.tab, args.layout, args.layoutLeafIds) !== args.leafId) {
    return null
  }
  return resolvePaneAgentOwner({ launchAgent: args.tab.launchAgent })
}
