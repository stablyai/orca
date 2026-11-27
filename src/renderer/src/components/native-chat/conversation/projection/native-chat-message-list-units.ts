import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptProjection } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatTurnJournal } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { NativeChatFoldUnit } from '../../../../../../shared/native-chat/transcript/folding/native-chat-fold-units'
import type { NativeChatToolFoldKind } from '../../../../../../shared/native-chat/tools/native-chat-tool-fold'

function sameMessage(left: NativeChatMessage, right: NativeChatMessage): boolean {
  // Most rows retain input identity; only folded assistant runs need field comparison.
  if (left === right) {
    return true
  }
  const keys = Object.keys(left) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && (key === 'blocks' || left[key] === right[key])
    ) &&
    left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => block === right.blocks[index])
  )
}

/** Folding clones a run's head even when every contributing block is unchanged. */
export function settleUnit(unit: NativeChatFoldUnit, before: NativeChatFoldUnit | undefined) {
  if (!before || unit === before) {
    return unit
  }
  const prior = new Map(before.rows.map((row) => [row.id, row]))
  const rows = unit.rows.map((row) => {
    const held = prior.get(row.id)
    return held && sameMessage(held, row) ? held : row
  })
  return rows.every((row, index) => row === unit.rows[index]) ? unit : { ...unit, rows }
}

/** The conversation, or one subagent's rows within one parent turn, folded by units. */
export type NativeChatListScope = {
  agentId: string | null
  /** Where the scope's rows start in its agent's subagent rows; 0 for the conversation. */
  offset: number
  ids: Set<string>
  units: NativeChatFoldUnit[]
  /** Each unit's first row within the scope's rows. */
  starts: number[]
  /** A subagent chunk's parent turn, when its rows show it. */
  turn?: { key: string | undefined }
}

export type NativeChatListState = {
  input: readonly NativeChatMessage[]
  ids: Set<string>
  journal: NativeChatTurnJournal | null | undefined
  projection: NativeChatTranscriptProjection
  scopes: NativeChatListScope[]
  place: Map<NativeChatMessage, { scope: number; unit: number }>
  kinds: Map<NativeChatMessage, NativeChatToolFoldKind>
  /** Subagent rows' turn keys by journal turn, when the host states turn scopes. */
  turnKeys: Map<string, string | undefined> | null
  /** Input arrived in display order, every row journal-placed and ordinarily ranked, so appends can follow it. */
  ordered: boolean
}

export function unitStarts(units: readonly NativeChatFoldUnit[]): number[] {
  let start = 0
  return units.map((unit) => {
    const at = start
    start += unit.rows.length
    return at
  })
}
