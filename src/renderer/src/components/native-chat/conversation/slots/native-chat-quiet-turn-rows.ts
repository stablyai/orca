import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatQuietTurns as quietTurns } from '../../../../../../shared/native-chat/transcript/turns/native-chat-quiet-turns'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'

/** The rows and turn bars a quiet turn hides; a turn with a diff or an opened PR stays. */
export function nativeChatQuietTurns(
  input: Pick<NativeChatTranscriptSlotsInput, 'turnKeys' | 'turnDiffs' | 'openedPullRequests'>,
  rows: readonly NativeChatMessage[],
  settledTurnKeys: ReadonlySet<string>
): ReturnType<typeof quietTurns> {
  const { turnKeys, turnDiffs, openedPullRequests } = input
  return quietTurns(
    rows,
    turnKeys,
    settledTurnKeys,
    (key) => turnDiffs.has(key) || openedPullRequests?.has(key) === true
  )
}
