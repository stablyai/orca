// When a launch-time draft (context prefilled into the agent's TUI input, never
// submitted) stops being live. Pure so the rule stays unit-testable without React.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { LIFECYCLE_CLOCK_SKEW_SLACK_MS } from './native-chat-live-status'

/** The transcript's user turns as seen when a launch draft was first observed.
 *  A new *tail* turn past this is the timestamp-free proof that the TUI prefill
 *  was resolved; "load earlier" prepends, so it cannot move the tail. */
export type NativeChatLaunchDraftTurnBaseline = {
  userTurnCount: number
  lastUserTurnId: string | null
}

export function nativeChatLaunchDraftTurnBaseline(
  messages: NativeChatMessage[]
): NativeChatLaunchDraftTurnBaseline {
  const userTurns = messages.filter((message) => message.role === 'user')
  return {
    userTurnCount: userTurns.length,
    lastUserTurnId: userTurns.at(-1)?.id ?? null
  }
}

// Why: the TUI input holds one line — any user turn after the draft was seeded
// means that prefill was either submitted with the turn or deliberately cleared
// first, so the composer copy must not linger as stale context. Text matching
// would miss TUI-edited submissions and concatenated remote sends.
//
// A launch draft is seeded at agent launch, so its session starts with zero user
// turns. That makes "not provably older than the seed" the right test rather than
// "stamped after the seed": Grok omits row timestamps entirely, and a remote
// host's JSONL clock can trail the renderer's. Only a turn whose own timestamp
// puts it before the seed by more than the cross-host slack is treated as
// pre-existing history (a resumed session, or a `load earlier` page).
export function launchDraftResolvedByTranscript(
  entry: Pick<NativeChatLaunchDraft, 'createdAt'>,
  messages: NativeChatMessage[],
  baseline?: NativeChatLaunchDraftTurnBaseline | null
): boolean {
  const provablyOlder = (message: NativeChatMessage): boolean =>
    message.timestamp !== null &&
    message.timestamp + LIFECYCLE_CLOCK_SKEW_SLACK_MS < entry.createdAt
  if (messages.some((message) => message.role === 'user' && !provablyOlder(message))) {
    return true
  }
  // Backstop for host clock skew wider than the slack: the transcript grew a new
  // tail user turn since the draft was first observed.
  if (!baseline) {
    return false
  }
  const userTurns = messages.filter((message) => message.role === 'user')
  return (
    userTurns.length > baseline.userTurnCount &&
    (userTurns.at(-1)?.id ?? null) !== baseline.lastUserTurnId
  )
}
