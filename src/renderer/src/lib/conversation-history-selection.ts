import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../shared/execution-host'

export type ConversationHistoryTarget = {
  executionHostId: ExecutionHostId
  agent: AiVaultAgent
  sessionId: string
  scope: 'all' | 'project'
}

let pendingTarget: ConversationHistoryTarget | null = null

export function selectConversationHistoryTarget(target: ConversationHistoryTarget): void {
  pendingTarget = target
}

export function consumeConversationHistoryTarget(): ConversationHistoryTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}
