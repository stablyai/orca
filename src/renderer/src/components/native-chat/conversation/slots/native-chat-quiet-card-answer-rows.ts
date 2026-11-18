import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatQuietCardAnswerRows as quietRows } from '../../../../../../shared/native-chat/transcript/turns/native-chat-quiet-card-answer-turns'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'

/** The transcript rows a quiet card-answer turn hides; a turn with a diff or an opened PR stays. */
export function nativeChatQuietCardAnswerRows(
  input: Pick<NativeChatTranscriptSlotsInput, 'turnKeys' | 'turnDiffs' | 'openedPullRequests'>,
  rows: readonly NativeChatMessage[],
  settledTurnKeys: ReadonlySet<string>
): ReadonlySet<number> {
  const { turnKeys, turnDiffs, openedPullRequests } = input
  return quietRows(
    rows,
    turnKeys,
    settledTurnKeys,
    (key) => turnDiffs.has(key) || openedPullRequests?.has(key) === true
  )
}
