// The reasoning row, as desktop and mobile both draw it: whether it draws at all, and what its
// collapsed headline says. Read from host facts only — the row's start (`timestamp`) and the end
// the host saw — so every client tells the same story about one row.

import { formatNativeChatDuration } from './native-chat-turn-status'
import type { NativeChatMessage } from './native-chat-types'

/** A reasoning row still being written in a turn that is running. It draws nothing until it ends:
 *  the turn's activity line is what says the agent is thinking, and one live indicator is enough. */
export function isNativeChatReasoningUnderway(
  message: Pick<NativeChatMessage, 'role' | 'state'>,
  turnIsWorking: boolean
): boolean {
  return message.role === 'reasoning' && message.state === 'running' && turnIsWorking
}

export type NativeChatReasoningHeadline =
  /** From a host that kept no lifecycle: nothing is claimed. */
  | { kind: 'reasoning' }
  /** Ended, with no span the host saw. */
  | { kind: 'thought' }
  | { kind: 'thoughtFor'; duration: string }

export function nativeChatReasoningHeadline(
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>
): NativeChatReasoningHeadline {
  if (message.state === undefined) {
    return { kind: 'reasoning' }
  }
  // An open row in a turn that is no longer live ended unseen, so it claims no duration.
  if (
    message.state !== 'completed' ||
    message.completedAt === undefined ||
    message.timestamp === null
  ) {
    return { kind: 'thought' }
  }
  return {
    kind: 'thoughtFor',
    duration: formatNativeChatDuration(
      Math.max(1, (message.completedAt - message.timestamp) / 1000)
    )
  }
}

/** English copy for clients without a translation catalog; desktop translates the same three. */
const NATIVE_CHAT_REASONING_COPY = {
  reasoning: 'Reasoning',
  thought: 'Thought',
  thoughtFor: (duration: string) => `Thought for ${duration}`
} as const

export function nativeChatReasoningHeadlineText(headline: NativeChatReasoningHeadline): string {
  return headline.kind === 'thoughtFor'
    ? NATIVE_CHAT_REASONING_COPY.thoughtFor(headline.duration)
    : NATIVE_CHAT_REASONING_COPY[headline.kind]
}
