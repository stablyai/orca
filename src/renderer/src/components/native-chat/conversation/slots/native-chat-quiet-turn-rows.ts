import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatQuietTurns as quietTurns } from '../../../../../../shared/native-chat/transcript/turns/native-chat-quiet-turns'
import { foldBotItemNotes } from '../../../../../../shared/bots/bot-item-note-runs'
import {
  nativeChatGeneratedImageAnswers,
  type NativeChatMarkdownImageSources
} from '../../../../../../shared/native-chat/transcript/images/native-chat-generated-image-answers'
import { nativeChatEventPlan } from '../../../../../../shared/native-chat/transcript/events/native-chat-event-plan'
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

/** The rows the transcript draws from: item notes folded, generated images answered, then back-to-back
 *  status rows about one thing merged past what quiet turns hide. */
export function nativeChatShownRows(
  input: NativeChatTranscriptSlotsInput,
  settledTurnKeys: ReadonlySet<string>,
  imageSources: NativeChatMarkdownImageSources
): { quiet: ReturnType<typeof quietTurns>; messages: readonly NativeChatMessage[] } {
  const { turnKeys, turnDiffs, openedPullRequests, workers = [] } = input
  const rows = nativeChatGeneratedImageAnswers(
    foldBotItemNotes(input.messages, turnKeys),
    turnKeys,
    settledTurnKeys,
    imageSources
  )
  const quiet = nativeChatQuietTurns(input, rows, settledTurnKeys)
  const messages = nativeChatEventPlan(rows, {
    turnKeys,
    workers,
    quiet,
    turnEndsDrawing: (key) => turnDiffs.has(key) || openedPullRequests?.has(key) === true
  })
  return { quiet, messages }
}
