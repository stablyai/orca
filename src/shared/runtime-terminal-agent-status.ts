import type { AgentContextUsage } from './agent-context-pressure'

export type RuntimeTerminalAgentStatusState = 'working' | 'permission' | 'idle' | null

export type RuntimeTerminalAgentStatus = {
  handle: string
  isRunningAgent: boolean
  status: RuntimeTerminalAgentStatusState
  /** Provider-reported context-window usage of the freshest explicit status row; absent when unknown. */
  contextUsage?: AgentContextUsage | null
}
