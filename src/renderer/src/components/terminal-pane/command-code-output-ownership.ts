import type { AgentType } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** All agent inputs must be BASE-resolved by the caller (resolvePaneOwnerBaseAgent):
 *  a command-code-based custom pane owner arrives as its custom id otherwise and
 *  would never match, permanently vetoing output-derived status. */
export function canCommandCodeOutputOwnPane(args: {
  foregroundAgent?: TuiAgent | null
  shellForeground?: boolean
  paneOwnerAgent?: AgentType | null
  retainedPaneOwnerAgent?: AgentType | null
}): boolean {
  if (args.foregroundAgent) {
    return args.foregroundAgent === 'command-code'
  }
  if (args.shellForeground) {
    return false
  }
  const paneOwnerAgent =
    args.paneOwnerAgent && args.paneOwnerAgent !== 'unknown'
      ? args.paneOwnerAgent
      : (args.retainedPaneOwnerAgent ?? args.paneOwnerAgent)
  return !paneOwnerAgent || paneOwnerAgent === 'unknown' || paneOwnerAgent === 'command-code'
}
