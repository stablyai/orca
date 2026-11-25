// An older page that reaches a turn's prompt settles that turn, and a settled turn folds its work.
// The reader was looking at that work at the oldest loaded rows, so the turn stays open for them,
// exactly as if they had opened it; they can still fold it from its status row.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NO_CARRIED_RUN_DISCLOSURES,
  nativeChatFindCarriedRunDisclosures
} from './native-chat-carried-run-disclosures'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

/** One committed build: what was loaded, which turn each row belongs to, and what was drawn. */
export type NativeChatTranscriptBuild = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  slots: readonly NativeChatTranscriptSlot[]
}

export const NO_TURNS: ReadonlySet<string> = new Set()

export function withTurns(
  turns: ReadonlySet<string>,
  more: ReadonlySet<string>
): ReadonlySet<string> {
  return more.size === 0 ? turns : new Set([...turns, ...more])
}

/** What the transcript remembers about its head between first-row changes. */
export type NativeChatHeadTrack = {
  /** The build when the first row last changed (or at mount): what the reader had at the head. */
  build: NativeChatTranscriptBuild | null
  /** Turns an older page would have folded, until the reader's expanded turns take them over. */
  held: ReadonlySet<string>
  /** Runs whose head moved earlier, by their current head, with the disclosure id each keeps. */
  carried: ReadonlyMap<string, string>
  /** The reader paged older history since the head was recorded: the next older rows are theirs,
   *  not a chat's first load arriving in steps. */
  paging: boolean
}

export const NO_HEAD_TRACK: NativeChatHeadTrack = {
  build: null,
  held: NO_TURNS,
  carried: NO_CARRIED_RUN_DISCLOSURES,
  paging: false
}

function drawnIds(slot: NativeChatTranscriptSlot): readonly string[] {
  if (slot.kind !== 'message' || slot.folded || !slot.drawsMessage) {
    return []
  }
  return slot.workRun ? slot.workRun.map((member) => member.id) : [slot.message.id]
}

function rowIds(slot: NativeChatTranscriptSlot): readonly string[] {
  if (slot.kind !== 'message') {
    return []
  }
  return slot.workRun ? slot.workRun.map((member) => member.id) : [slot.message.id]
}

/**
 * Turns that would fold rows the previous build drew at its head, now that older rows were drawn
 * before that head. Only a commit whose first row changed can do this, and only then does this
 * scan anything; a live turn settling keeps its first row, so it folds as usual.
 */
export function nativeChatTurnsHeldOpen(
  previous: NativeChatTranscriptBuild | null,
  current: NativeChatTranscriptBuild,
  expandedTurnKeys: ReadonlySet<string>
): ReadonlySet<string> {
  const previousFirst = previous?.messages[0]?.id
  if (!previous || previousFirst === undefined || current.messages[0]?.id === previousFirst) {
    return NO_TURNS
  }
  // The previous head's turn group: its leading rows that shared the first row's turn.
  const headKey = previous.turnKeys[0]
  const group = new Set<string>()
  for (const [index, message] of previous.messages.entries()) {
    if (previous.turnKeys[index] !== headKey) {
      break
    }
    group.add(message.id)
  }
  const drawnBefore = new Set<string>()
  for (const slot of previous.slots) {
    const ids = rowIds(slot)
    if (ids.length > 0 && !ids.some((id) => group.has(id))) {
      break
    }
    for (const id of drawnIds(slot)) {
      if (group.has(id)) {
        drawnBefore.add(id)
      }
    }
  }
  if (drawnBefore.size === 0) {
    return NO_TURNS
  }
  const drawnNow = new Set(current.slots.flatMap(drawnIds))
  // Only a turn that folds now: holding any other open would change how it later settles.
  const folding = new Set(
    current.slots.flatMap((slot) =>
      slot.kind === 'message' && slot.turnFolds && slot.turnKey !== undefined ? [slot.turnKey] : []
    )
  )
  const turnOf = new Map<string, string | undefined>()
  for (const [index, message] of current.messages.entries()) {
    if (drawnBefore.has(message.id)) {
      turnOf.set(message.id, current.turnKeys[index])
    }
  }
  const held = new Set<string>()
  for (const id of drawnBefore) {
    const turnKey = turnOf.get(id)
    if (
      turnKey !== undefined &&
      folding.has(turnKey) &&
      !drawnNow.has(id) &&
      !expandedTurnKeys.has(turnKey)
    ) {
      held.add(turnKey)
    }
  }
  return held.size > 0 ? held : NO_TURNS
}

/** The head track after a commit whose first row changed: turns to hold, runs to carry. */
export function nativeChatNextHeadTrack(
  head: NativeChatHeadTrack,
  input: NativeChatTranscriptSlotsInput,
  slots: readonly NativeChatTranscriptSlot[],
  paging: boolean
): NativeChatHeadTrack {
  const current = { messages: input.messages, turnKeys: input.turnKeys, slots }
  // Only older rows the reader paged in can fold a turn they saw or move a run's head; a window
  // trimming its head, or a first load arriving in steps, can't.
  if (
    head.build === null ||
    !(head.paging || paging) ||
    input.messages.length <= head.build.messages.length
  ) {
    return { ...head, build: current, paging }
  }
  const expanded = withTurns(input.expandedTurnKeys, head.held)
  const held = nativeChatTurnsHeldOpen(head.build, current, expanded)
  // A held turn draws its runs again; find carries among them as they will be drawn.
  const drawn =
    held.size === 0
      ? slots
      : buildNativeChatTranscript({ ...input, expandedTurnKeys: withTurns(expanded, held) }).slots
  return {
    build: current,
    held: withTurns(head.held, held),
    carried: nativeChatFindCarriedRunDisclosures(head.build.slots, drawn, head.carried),
    paging
  }
}
