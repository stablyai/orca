import type { AgentSessionReviewTarget } from './agent-session-review-target'
import type { AgentSessionFailureFact } from './failures/agent-session-failure'
import type { AgentSessionFailureSentence } from './failures/agent-session-failure-words'
import type { AgentSessionQueuedSendReceipt } from './agent-session-wire'

export type AgentSessionConversationCommand = 'clear' | 'compact' | 'review'

/** What the user typed and what a text-driven agent receives. */
export function agentSessionCompactCommandText(instructions?: string): string {
  return instructions ? `/compact ${instructions}` : '/compact'
}

/** The fields a command's mutation is fingerprinted over: host and clients must build the same ones. */
export function agentSessionConversationCommandFields(
  command: AgentSessionConversationCommand,
  options: {
    instructions?: string
    delivery?: 'queue-if-active'
    review?: AgentSessionReviewTarget
  } = {}
): Record<string, unknown> {
  return {
    command,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.review ? { review: options.review } : {})
  }
}

/** How long a client waits for a conversation command: the host may first start an agent at rest. */
export const AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS = 195_000

export type AgentSessionConversationCommandResult = {
  command: AgentSessionConversationCommand
  state: 'completed' | 'unknown'
  replacementSessionId?: string
  /** A completed /compact card queued behind current work; only clients that sent delivery receive it. */
  queued?: AgentSessionQueuedSendReceipt
} &
  /** `error`: a sentence for a person; released clients print it as it is. */
  (
    | { error?: string; failure?: undefined }
    /** Written with its sentence by agentSessionFailureWords; absent on older hosts. */
    | { error: AgentSessionFailureSentence; failure: AgentSessionFailureFact }
  )

export type AgentSessionConversationCommandRecord = AgentSessionConversationCommandResult & {
  runtimeFence?: number
  operationId: string
  callerKey: string
  phase: 'prepared' | 'committed'
}

/** A newer host may answer with a command this build doesn't know. */
export function isAgentSessionConversationCommand(
  value: unknown
): value is AgentSessionConversationCommand {
  return value === 'clear' || value === 'compact' || value === 'review'
}

export function isAgentSessionConversationCommandResult(
  value: unknown
): value is AgentSessionConversationCommandResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const row = value as AgentSessionConversationCommandResult
  return (
    isAgentSessionConversationCommand(row.command) &&
    (row.state === 'completed' || row.state === 'unknown') &&
    (row.replacementSessionId === undefined ||
      (typeof row.replacementSessionId === 'string' &&
        /^[A-Za-z0-9_-]{8,128}$/.test(row.replacementSessionId))) &&
    (row.error === undefined || (typeof row.error === 'string' && row.error.length <= 4096))
  )
}

export function isAgentSessionConversationCommandRecord(
  value: unknown
): value is AgentSessionConversationCommandRecord {
  if (!isAgentSessionConversationCommandResult(value)) {
    return false
  }
  const row = value as AgentSessionConversationCommandRecord
  return (
    (row.phase === 'prepared' || row.phase === 'committed') &&
    (row.runtimeFence === undefined ||
      (Number.isSafeInteger(row.runtimeFence) && row.runtimeFence >= 0)) &&
    typeof row.operationId === 'string' &&
    row.operationId.length > 0 &&
    row.operationId.length <= 512 &&
    typeof row.callerKey === 'string' &&
    row.callerKey.length > 0 &&
    row.callerKey.length <= 512
  )
}
