import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatQuietTurns as quietTurns } from '../../../../../../shared/native-chat/transcript/turns/native-chat-quiet-turns'
import { foldBotItemNotes } from '../../../../../../shared/bots/bot-item-note-runs'
import {
  nativeChatGeneratedImageAnswers,
  type NativeChatMarkdownImageSources
} from '../../../../../../shared/native-chat/transcript/images/native-chat-generated-image-answers'
import { nativeChatEventPlan } from '../../../../../../shared/native-chat/transcript/events/native-chat-event-plan'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

type QuietTurns = ReturnType<typeof quietTurns>

const NO_QUIET: QuietTurns = { rows: new Set(), turns: new Set() }

/** The rows and turn bars quiet turns hide (a turn with a diff or an opened PR stays), split into
 *  those gone and those still fading out (`leavingTurnKeys`). */
function nativeChatQuietTurns(
  input: Pick<
    NativeChatTranscriptSlotsInput,
    'turnKeys' | 'turnDiffs' | 'openedPullRequests' | 'turnStatuses' | 'leavingTurnKeys'
  >,
  rows: readonly NativeChatMessage[]
): { quiet: QuietTurns; leaving: QuietTurns } {
  const { turnKeys, turnDiffs, openedPullRequests, turnStatuses, leavingTurnKeys } = input
  const all = quietTurns(
    rows,
    turnKeys,
    turnStatuses.completedByTurn,
    (key) => turnDiffs.has(key) || openedPullRequests?.has(key) === true
  )
  if (!leavingTurnKeys?.size) {
    return { quiet: all, leaving: NO_QUIET }
  }
  const split = (leaving: boolean): QuietTurns => ({
    rows: new Set(
      [...all.rows].filter((index) => leavingTurnKeys.has(turnKeys[index]!) === leaving)
    ),
    turns: new Set([...all.turns].filter((key) => leavingTurnKeys.has(key) === leaving))
  })
  return { quiet: split(false), leaving: split(true) }
}

/** The rows the transcript draws from: item notes folded, generated images answered, then back-to-back
 *  status rows about one thing merged past what quiet turns hide. */
export function nativeChatShownRows(
  input: NativeChatTranscriptSlotsInput,
  settledTurnKeys: ReadonlySet<string>,
  imageSources: NativeChatMarkdownImageSources
): { quiet: QuietTurns; leaving: QuietTurns; messages: readonly NativeChatMessage[] } {
  const { turnKeys, turnDiffs, openedPullRequests, workers = [] } = input
  const rows = nativeChatGeneratedImageAnswers(
    foldBotItemNotes(input.messages, turnKeys),
    turnKeys,
    settledTurnKeys,
    imageSources
  )
  const { quiet, leaving } = nativeChatQuietTurns(input, rows)
  const messages = nativeChatEventPlan(rows, {
    turnKeys,
    workers,
    quiet,
    turnEndsDrawing: (key) => turnDiffs.has(key) || openedPullRequests?.has(key) === true
  })
  return { quiet, leaving, messages }
}

/** A settling quiet turn's row that fades out whole: one of its hidden rows, or the row holding only
 *  its bar. */
export function nativeChatSlotLeavesWhole(slot: NativeChatTranscriptSlot): boolean {
  return (
    slot.kind === 'message' &&
    (slot.leaving === 'row' ||
      (slot.leaving === 'bar' && !slot.drawsMessage && !slot.turnDiff && !slot.openedPullRequests))
  )
}
