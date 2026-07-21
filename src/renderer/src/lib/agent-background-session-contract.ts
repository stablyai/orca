import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'

export type LaunchAgentBackgroundSessionArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  launchSource?: LaunchSource
  title?: string
  onData?: (chunk: string) => void
  onExit?: (ptyId: string, code: number) => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}

export type LaunchAgentBackgroundSessionResult = {
  tabId: string
  paneKey: string
  ptyId: string
  startupPlan: AgentStartupPlan
  terminalOwnership: AutomationTerminalOwnership | null
}
