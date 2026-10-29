import type { AgentType } from '../../../../shared/agent-status-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'

export function canCommandCodeOutputOwnPane(args: {
  foregroundAgent?: TerminalAgent | null
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
