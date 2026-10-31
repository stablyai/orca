import type { AgentType, NativeChatSubagentState } from './native-chat-types'

export const ORCHESTRATION_SESSION_CHILDREN_CAPABILITY =
  'orchestration.session-children.v1' as const

export type OrchestrationChildConversation =
  | { kind: 'journal'; sessionId: string; agent: AgentType; workspaceId: string }
  | {
      kind: 'unavailable'
      reason: 'terminal-worker' | 'remote-worker' | 'identity-unverifiable'
    }

export type OrchestrationChildExecutionHost =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'environment'; environmentId: string; label?: string }

export type OrchestrationChildMetadata = {
  agent?: AgentType
  executionHost?: OrchestrationChildExecutionHost
}

export type OrchestrationSessionChild = {
  dispatchId: string
  taskId: string
  runId: string
  label: string
  state: NativeChatSubagentState
  workerState: string
  startedAt: number
  settledAt?: number
  result: string | null
  conversation: OrchestrationChildConversation
  /** Retained display facts; never an authority to open or control a worker. */
  metadata?: OrchestrationChildMetadata
}

export type OrchestrationSessionChildren = {
  children: OrchestrationSessionChild[]
  nextCursor: string | null
}
