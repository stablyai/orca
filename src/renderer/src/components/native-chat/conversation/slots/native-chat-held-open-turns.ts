// An older page that reaches a turn's prompt settles that turn, and a settled turn folds its work.
// The reader was looking at that work at the oldest loaded rows, so the turn stays open for them,
// exactly as if they had opened it; they can still fold it from its status row.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** One committed build: what was loaded, which turn each row belongs to, and what was drawn. */
export type NativeChatTranscriptBuild = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  slots: readonly NativeChatTranscriptSlot[]
}

const NO_TURNS: ReadonlySet<string> = new Set()

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
