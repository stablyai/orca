import type { AgentType } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Whether a scraped output status for `agent` may write this pane's status row. */
export function canAgentOutputOwnPane(args: {
  agent: TuiAgent
  foregroundAgent?: TuiAgent | null
  shellForeground?: boolean
  paneOwnerAgent?: AgentType | null
  retainedPaneOwnerAgent?: AgentType | null
}): boolean {
  if (args.foregroundAgent) {
    return args.foregroundAgent === args.agent
  }
  if (args.shellForeground) {
    return false
  }
  const paneOwnerAgent =
    args.paneOwnerAgent && args.paneOwnerAgent !== 'unknown'
      ? args.paneOwnerAgent
      : (args.retainedPaneOwnerAgent ?? args.paneOwnerAgent)
  return !paneOwnerAgent || paneOwnerAgent === 'unknown' || paneOwnerAgent === args.agent
}
