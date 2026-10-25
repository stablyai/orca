import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { LIFECYCLE_CLOCK_SKEW_SLACK_MS } from './native-chat-live-status'

/** A new tail turn proves resolution without timestamps; older-history prepends cannot advance it. */
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

// Resolve on user turns not provably older than the seed, allowing missing timestamps and host-clock slack; text matching misses TUI edits.
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
  // Use tail growth to cover cross-host clock skew beyond timestamp slack.
  if (!baseline) {
    return false
  }
  const userTurns = messages.filter((message) => message.role === 'user')
  return (
    userTurns.length > baseline.userTurnCount &&
    (userTurns.at(-1)?.id ?? null) !== baseline.lastUserTurnId
  )
}
