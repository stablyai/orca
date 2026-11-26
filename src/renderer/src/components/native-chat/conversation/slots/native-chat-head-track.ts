// What the transcript remembers about its head between first-row changes, and what an older page
// changes there (older-history paging, including the mount prefetch): turns kept open, and rows
// that keep their run's disclosures.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NO_CARRIED_RUN_DISCLOSURES,
  nativeChatFindCarriedRunDisclosures,
  nativeChatLoadedCarries
} from './native-chat-carried-run-disclosures'
import { NO_TURNS, nativeChatTurnsHeldOpen, withTurns } from './native-chat-held-open-turns'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import { nativeChatRowSuccessors } from './native-chat-row-successors'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

export type NativeChatHeadTrack = {
  /** Whose history this is; another source starts over. */
  source: string | undefined
  /** The rows and their turns when the first row last changed: the window a page lands on. */
  window: {
    messages: readonly NativeChatMessage[]
    turnKeys: readonly (string | undefined)[]
  } | null
  /** Turns an older page would have folded, until the reader's expanded turns take them over. */
  held: ReadonlySet<string>
  /** Rows whose run an older page grew at its start, with the disclosure id each keeps. */
  carried: ReadonlyMap<string, string>
  /** An older-history page (including the mount prefetch) is in flight, or was in the commit
   *  before: the older rows it lands are the reader's paging, not a chat's first load arriving in
   *  steps. Set when a request starts; cleared when it lands or ends without landing. */
  paging: boolean
}

export const NO_HEAD_TRACK: NativeChatHeadTrack = {
  source: undefined,
  window: null,
  held: NO_TURNS,
  carried: NO_CARRIED_RUN_DISCLOSURES,
  paging: false
}

/** Older rows arrived before the head: the old first row is still loaded further down, or an
 *  earlier row took in its tool calls. A window trimming its head is neither, whatever the count. */
export function nativeChatOlderRowsArrived(
  previous: readonly NativeChatMessage[],
  current: readonly NativeChatMessage[]
): boolean {
  const first = previous[0]
  if (!first || current[0] === undefined || current[0].id === first.id) {
    return false
  }
  return nativeChatRowSuccessors(previous, current, [first.id]).has(first.id)
}

/**
 * The head track after a commit whose first row changed. `input` is this commit's (with the
 * reader's own expanded turns and the carries in use); `slots` is what it draws.
 */
export function nativeChatNextHeadTrack(
  head: NativeChatHeadTrack,
  input: NativeChatTranscriptSlotsInput,
  slots: readonly NativeChatTranscriptSlot[],
  paging: boolean
): NativeChatHeadTrack {
  const window = { messages: input.messages, turnKeys: input.turnKeys }
  const previous = head.window
  if (
    !previous ||
    !(head.paging || paging) ||
    !nativeChatOlderRowsArrived(previous.messages, input.messages)
  ) {
    return {
      ...head,
      window,
      paging,
      carried: nativeChatLoadedCarries(head.carried, input.messages)
    }
  }
  const expanded = withTurns(input.expandedTurnKeys, head.held)
  // The window the page landed on, drawn as it would be now: with the reader's folds, the turns
  // already held and the carries in use, so what it drew is what the reader has.
  const before = {
    ...previous,
    slots: buildNativeChatTranscript({
      ...input,
      ...previous,
      expandedTurnKeys: expanded,
      carriedDisclosureIds: head.carried
    }).slots
  }
  const held = nativeChatTurnsHeldOpen(before, { ...window, slots }, expanded)
  // A held turn draws its runs again; find carries among them as they will be drawn.
  const drawn =
    held.size === 0
      ? slots
      : buildNativeChatTranscript({
          ...input,
          expandedTurnKeys: withTurns(expanded, held),
          carriedDisclosureIds: head.carried
        }).slots
  const carried = nativeChatFindCarriedRunDisclosures(
    before,
    { messages: input.messages, slots: drawn },
    head.carried
  )
  return {
    ...head,
    window,
    held: withTurns(head.held, held),
    carried: nativeChatLoadedCarries(carried, input.messages),
    paging
  }
}
