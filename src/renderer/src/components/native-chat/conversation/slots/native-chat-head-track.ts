// What the transcript remembers about the window an older page lands on, and what an applied
// older-history page (including the mount prefetch) changes there: turns kept open, and the run it
// grew at its start keeping its disclosures.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NO_CARRIED_RUN_DISCLOSURES,
  nativeChatCarryAcrossPage,
  nativeChatLoadedCarries
} from './native-chat-carried-run-disclosures'
import { NO_TURNS, nativeChatTurnsHeldOpen, withTurns } from './native-chat-held-open-turns'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import { nativeChatRowSuccessors } from './native-chat-row-successors'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

type HeadWindow = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
}

export type NativeChatHeadTrack = {
  /** Whose transcript this is; another one starts over. */
  session: string | undefined
  /** Its older-history generation; a trim or reset records a new window. */
  generation: number | undefined
  /** Older pages applied as of the window. */
  pages: number
  /** The rows as of their last structural change: the window the next page lands on. */
  window: HeadWindow | null
  /** Turns a page would have folded, drawn open until the reader's expanded turns hold them. */
  held: ReadonlySet<string>
  /** The reader's expanded turns when `held` was handed to them; any later set has them. */
  heldSince: ReadonlySet<string> | null
  /** Rows whose run a page grew at its start, with the disclosure id each keeps. */
  carried: ReadonlyMap<string, string>
}

export const NO_HEAD_TRACK: NativeChatHeadTrack = {
  session: undefined,
  generation: undefined,
  pages: 0,
  window: null,
  held: NO_TURNS,
  heldSince: null,
  carried: NO_CARRIED_RUN_DISCLOSURES
}

/** One commit, as the slots hook sees it. */
export type NativeChatHeadStep = {
  session: string | undefined
  generation: number | undefined
  /** Older pages applied, counted with the update that applies each. */
  pages: number
  /** This commit's input, with the reader's own expanded turns and the carries in use. */
  input: NativeChatTranscriptSlotsInput
  /** `input.messages` as of their last structural change, row for row. */
  structure: readonly NativeChatMessage[]
  /** What this commit draws. */
  slots: readonly NativeChatTranscriptSlot[]
}

/** How an applied page continues the window it landed on: the row now holding the window's first
 *  row (that row further down, or an earlier row that took in its tool calls), with every later
 *  row of the window right after it in order. Null for a reorder, a replacement, or a page that
 *  added nothing before the window. */
export function nativeChatPageContinuation(
  previous: readonly NativeChatMessage[],
  current: readonly NativeChatMessage[]
): { first: string; successor: string } | null {
  const first = previous[0]
  if (!first) {
    return null
  }
  let at = current.findIndex((message) => message.id === first.id)
  if (at === -1) {
    const owner = nativeChatRowSuccessors([first], current, [first.id]).get(first.id)
    at = owner === undefined ? -1 : current.findIndex((message) => message.id === owner)
  }
  const successor = current[at]
  if (!successor || (at === 0 && successor.id === first.id)) {
    return null
  }
  for (let index = 1; index < previous.length; index += 1) {
    if (current[at + index]?.id !== previous[index]!.id) {
      return null
    }
  }
  return { first: first.id, successor: successor.id }
}

function acceptedPage(
  head: NativeChatHeadTrack,
  step: NativeChatHeadStep,
  window: HeadWindow
): NativeChatHeadTrack {
  const { input, slots } = step
  const next = {
    ...head,
    pages: step.pages,
    window,
    carried: nativeChatLoadedCarries(head.carried, input.messages)
  }
  const continued = head.window && nativeChatPageContinuation(head.window.messages, input.messages)
  if (!head.window || !continued) {
    return next
  }
  const expanded = withTurns(input.expandedTurnKeys, head.held)
  // The window the page landed on, drawn as it would be now: with the reader's folds, the turns
  // already held and the carries in use, so what it drew is what the reader has.
  const before = {
    ...head.window,
    slots: buildNativeChatTranscript({
      ...input,
      ...head.window,
      expandedTurnKeys: expanded,
      carriedDisclosureIds: head.carried
    }).slots
  }
  const follow = (id: string): string => (id === continued.first ? continued.successor : id)
  const held = nativeChatTurnsHeldOpen(
    before,
    { messages: input.messages, turnKeys: input.turnKeys, slots },
    expanded,
    follow
  )
  // A held turn draws its runs again; carry among them as they will be drawn.
  const drawn =
    held.size === 0
      ? slots
      : buildNativeChatTranscript({
          ...input,
          expandedTurnKeys: withTurns(expanded, held),
          carriedDisclosureIds: head.carried
        }).slots
  const carried = nativeChatCarryAcrossPage(before.slots, drawn, continued, head.carried)
  return {
    ...next,
    held: withTurns(head.held, held),
    heldSince: held.size === 0 ? head.heldSince : input.expandedTurnKeys,
    carried: nativeChatLoadedCarries(carried, input.messages)
  }
}

/**
 * The head track after a commit; `head` itself when nothing changed, so the hook can store it
 * during render. Only an applied page (its count moved) can hold a turn or carry a run; any other
 * structural change only keeps the window current.
 */
export function nativeChatHeadTrackStep(
  head: NativeChatHeadTrack,
  step: NativeChatHeadStep
): NativeChatHeadTrack {
  const window = { messages: step.structure, turnKeys: step.input.turnKeys }
  if (head.session !== step.session) {
    return {
      ...NO_HEAD_TRACK,
      session: step.session,
      generation: step.generation,
      pages: step.pages,
      window
    }
  }
  if (head.generation !== step.generation) {
    // A trim or reset: the window starts over, but rows still loaded keep their carried ids.
    return {
      ...head,
      generation: step.generation,
      pages: step.pages,
      window,
      held: NO_TURNS,
      heldSince: null,
      carried: nativeChatLoadedCarries(head.carried, step.input.messages)
    }
  }
  if (head.pages !== step.pages) {
    return acceptedPage(head, step, window)
  }
  if (head.held.size > 0 && step.input.expandedTurnKeys !== head.heldSince) {
    // The reader's expanded turns took the held ones over; their status row folds them as usual.
    return { ...head, held: NO_TURNS, heldSince: null }
  }
  if (head.window?.messages !== step.structure) {
    return { ...head, window, carried: nativeChatLoadedCarries(head.carried, step.input.messages) }
  }
  return head
}
