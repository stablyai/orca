import { buildAgentSessionHandoffContext } from '../../native-chat/transcript/agent-session-handoff-context'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isNativeChatCompactionBoundary } from '../../native-chat/native-chat-context-usage'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { isNativeChatContextClear } from '../agent-session-context-clear'
import { buildAgentSessionContinuationPrompt } from './agent-session-continuation'

/** What a fork's recap hands over: the whole history up to the fork point, or only what the agent
 *  still held there, from its last /compact or /clear on. */
export type ChatForkRecapScope = 'history' | 'current'

/** Your next message, or a /compact or /clear, starts what the fork point's turn doesn't include. */
function endsTurn(message: NativeChatMessage): boolean {
  return (
    message.role === 'user' ||
    isNativeChatContextClear(message) ||
    isNativeChatCompactionBoundary(message)
  )
}

/** The messages a recap describes, through the fork point's whole turn; null when it isn't loaded. */
export function chatForkRecapMessages(
  messages: readonly NativeChatMessage[],
  throughItemId: string,
  scope: ChatForkRecapScope = 'history'
): readonly NativeChatMessage[] | null {
  const index = messages.findIndex((message) => message.id === throughItemId)
  if (index === -1) {
    return null
  }
  let end = index + 1
  while (end < messages.length && !endsTurn(messages[end]!)) {
    end += 1
  }
  const through = messages.slice(0, end)
  if (scope === 'history') {
    return through
  }
  for (let at = through.length - 1; at >= 0; at -= 1) {
    const message = through[at]!
    if (isNativeChatContextClear(message)) {
      return through.slice(at + 1)
    }
    // The compaction row stays, so the recap says earlier turns were summarized away.
    if (isNativeChatCompactionBoundary(message)) {
      return through.slice(at)
    }
  }
  return through
}

/** The hand-off prompt for a fork's new session, built locally without asking any model; null when
 *  nothing up to the fork point has words to hand over. */
export function buildChatForkRecap(input: {
  messages: readonly NativeChatMessage[]
  throughItemId: string
  scope: ChatForkRecapScope
  sourceAgent: TuiAgent
  sourceTitle?: string
  sourceWorkingDirectory?: string | null
}): string | null {
  const messages = chatForkRecapMessages(input.messages, input.throughItemId, input.scope)
  if (!messages) {
    return null
  }
  return buildAgentSessionContinuationPrompt(
    {
      sourceKind: 'chat',
      sourceAgent: input.sourceAgent,
      sourceTitle: input.sourceTitle,
      sourceWorkingDirectory: input.sourceWorkingDirectory ?? null,
      capturedText: buildAgentSessionHandoffContext(messages)
    },
    'focused'
  )
}
