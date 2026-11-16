import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalAgent } from '../../../../../../shared/agent-status/identity/terminal-agent'

export function canCommandCodeOutputOwnPane(args: {
  foregroundAgent?: TerminalAgent | null
  shellForeground?: boolean
  paneOwnerAgent?: AgentType | null
}): boolean {
  if (args.foregroundAgent) {
    return args.foregroundAgent === 'command-code'
  }
  if (args.shellForeground) {
    return false
  }
  const paneOwnerAgent = args.paneOwnerAgent
  return !paneOwnerAgent || paneOwnerAgent === 'unknown' || paneOwnerAgent === 'command-code'
}
