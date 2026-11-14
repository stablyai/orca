import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  sameNativeChatRowPlacement,
  type NativeChatSubagentRow
} from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatTurnJournal } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import {
  compareNativeChatDisplayMessages as compareMessages,
  nativeChatDisplaySortRank
} from '../../../../../../shared/native-chat/transcript/messages/native-chat-message-order'
import {
  buildNativeChatFoldUnit,
  groupNativeChatFoldUnitMembers,
  type NativeChatFoldUnit
} from '../../../../../../shared/native-chat/transcript/folding/native-chat-fold-units'
import { nativeChatToolFoldKind } from '../../../../../../shared/native-chat/tools/native-chat-tool-fold'
import { isOrphanRowId } from '../../../../../../shared/native-chat/tools/native-chat-folded-tool-results'
import { subagentItemBlock } from '../../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { stripNoiseMessages } from '../../../../../../shared/native-chat/native-chat-noise'
import { agentJournalItemSubagentId } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import { appendedSubagentTurnKey, appendedTurnNeutralItems } from './native-chat-message-list-turns'
import {
  settleUnit,
  unitStarts,
  type NativeChatListScope,
  type NativeChatListState
} from './native-chat-message-list-units'

/** Revised rows re-fold only their unit, and conversation appends only the last unit onward; else null. */
export function reuseUnits(
  state: NativeChatListState,
  messages: readonly NativeChatMessage[],
  journal: NativeChatTurnJournal | null | undefined
): NativeChatListState | null {
  const before = state.input
  const subagents = state.projection.subagentRows.size > 0
  // Revisions keep every ordering field, so only appends need input already in display order.
  if (messages.length < before.length || (!state.ordered && messages.length !== before.length)) {
    return null
  }
  // Subagent rows keep their turns only while no earlier turn input changed.
  let appendedItems = subagents ? appendedTurnNeutralItems(state.journal, journal) : null
  // Only explicit turn scopes prove an appended row leaves earlier rows' turns alone.
  if (subagents && (!appendedItems || (messages.length > before.length && !state.turnKeys))) {
    return null
  }
  const changed: [NativeChatMessage, NativeChatMessage][] = []
  for (let index = 0; index < before.length; index += 1) {
    const prior = before[index]!
    const message = messages[index]!
    if (prior === message) {
      continue
    }
    if (
      prior.id !== message.id ||
      !sameNativeChatRowPlacement(prior, message) ||
      subagentItemBlock(prior) !== null ||
      subagentItemBlock(message) !== null ||
      // A conversation user row opens the turns subagent rows are grouped by.
      (subagents && message.role === 'user') ||
      state.kinds.get(prior) !== nativeChatToolFoldKind(message)
    ) {
      return null
    }
    changed.push([prior, message])
  }
  const appended = messages.slice(before.length)
  const appendedIds = new Set<string>()
  const appendedTurns = new Map<NativeChatMessage, string | undefined>()
  let last = before.at(-1)
  for (const message of appended) {
    if (agentJournalItemSubagentId(message) !== null) {
      appendedItems ??= appendedTurnNeutralItems(state.journal, journal)
      const turn =
        appendedItems &&
        state.turnKeys &&
        appendedSubagentTurnKey(message, appendedItems, state.turnKeys)
      if (!turn) {
        return null
      }
      appendedTurns.set(message, turn.turnKey)
    }
    if (
      !message.journalPosition ||
      nativeChatDisplaySortRank(message) !== 0 ||
      subagentItemBlock(message) !== null ||
      // A raw id shaped like a detached result's renames every later orphan.
      isOrphanRowId(message.id) ||
      state.ids.has(message.id) ||
      appendedIds.has(message.id) ||
      (last && compareMessages(last, message) >= 0)
    ) {
      return null
    }
    appendedIds.add(message.id)
    last = message
  }
  const scopes = state.scopes.slice()
  const edit = (index: number): NativeChatListScope => {
    if (scopes[index] === state.scopes[index]) {
      scopes[index] = { ...scopes[index]!, units: scopes[index]!.units.slice() }
    }
    return scopes[index]!
  }
  let conversation = state.projection.conversation
  const copiedRows = new Map<string, NativeChatSubagentRow[]>()
  const agentRowsFor = (agentId: string): NativeChatSubagentRow[] => {
    let rows = copiedRows.get(agentId)
    if (!rows) {
      rows = state.projection.subagentRows.get(agentId)?.slice() ?? []
      copiedRows.set(agentId, rows)
    }
    return rows
  }
  // Several revisions in one unit re-fold it once.
  const revisedUnits = new Map<
    string,
    { scope: number; unit: number; swaps: Map<NativeChatMessage, NativeChatMessage> }
  >()
  for (const [prior, message] of changed) {
    const at = state.place.get(prior)
    if (!at) {
      return null
    }
    const key = `${at.scope}:${at.unit}`
    const entry = revisedUnits.get(key) ?? { ...at, swaps: new Map() }
    entry.swaps.set(prior, message)
    revisedUnits.set(key, entry)
  }
  for (const { scope: scopeIndex, unit: unitIndex, swaps } of revisedUnits.values()) {
    const scope = edit(scopeIndex)
    const unit = scope.units[unitIndex]!
    // A refused reuse projects in full with fresh maps, so recording sources as we go is safe.
    for (const [prior, message] of swaps) {
      state.kinds.set(message, state.kinds.get(prior)!)
    }
    const rebuilt = settleUnit(
      buildNativeChatFoldUnit(
        unit.sources.map((source) => swaps.get(source) ?? source),
        scope.ids,
        state.kinds,
        unit,
        stripNoiseMessages
      ),
      unit
    )
    // Detached result ids are allocated across units, so only a full pass may change them.
    if (
      unit.orphans.length > 0 ||
      rebuilt.orphans.length > 0 ||
      rebuilt.rows.length !== unit.rows.length
    ) {
      return null
    }
    scope.units[unitIndex] = rebuilt
    for (const [prior, message] of swaps) {
      state.kinds.delete(prior)
      state.place.delete(prior)
      state.place.set(message, { scope: scopeIndex, unit: unitIndex })
    }
    if (rebuilt.rows.every((row, index) => row === unit.rows[index])) {
      continue
    }
    const start = scope.offset + scope.starts[unitIndex]!
    if (scope.agentId === null) {
      conversation =
        conversation === state.projection.conversation ? conversation.slice() : conversation
      conversation.splice(start, rebuilt.rows.length, ...rebuilt.rows)
    } else {
      const rows = agentRowsFor(scope.agentId)
      for (const [offset, row] of rebuilt.rows.entries()) {
        rows[start + offset] = { message: row, turnKey: rows[start + offset]!.turnKey }
      }
    }
  }
  // Each scope's appended rows re-fold from its last unit; a subagent row in a new turn opens a new chunk.
  const appendTo = (index: number, added: readonly NativeChatMessage[]): boolean => {
    const scope = edit(index)
    for (const message of added) {
      state.kinds.set(message, nativeChatToolFoldKind(message))
      state.ids.add(message.id)
      scope.ids.add(message.id)
    }
    const from = Math.max(0, scope.units.length - 1)
    const head = scope.units[from]
    const units: NativeChatFoldUnit[] = []
    for (const members of groupNativeChatFoldUnitMembers(
      [...(head?.sources ?? []), ...added],
      state.kinds
    )) {
      const held = members[0] === head?.sources[0] ? head : undefined
      const unit = settleUnit(
        buildNativeChatFoldUnit(members, scope.ids, state.kinds, held, stripNoiseMessages),
        held
      )
      if (unit.orphans.length > 0 || (held && held.orphans.length > 0)) {
        return false
      }
      unit.sources.forEach((source) =>
        state.place.set(source, { scope: index, unit: from + units.length })
      )
      units.push(unit)
    }
    const start = scope.starts[from] ?? 0
    scope.units.splice(from, scope.units.length - from, ...units)
    scope.starts = [
      ...scope.starts.slice(0, from),
      ...unitStarts(units).map((offset) => start + offset)
    ]
    const rows = units.flatMap((unit) => unit.rows)
    if (scope.agentId === null) {
      conversation = [...conversation.slice(0, start), ...rows]
      return true
    }
    const agentRows = agentRowsFor(scope.agentId)
    const turnKey = scope.turn?.key
    agentRows.splice(
      scope.offset + start,
      agentRows.length,
      ...rows.map((message) => ({ message, turnKey }))
    )
    return true
  }
  const own = appended.filter((message) => !appendedTurns.has(message))
  if (own.length > 0 && !appendTo(0, own)) {
    return null
  }
  // Per subagent, consecutive rows of one turn extend its last chunk or open the next.
  const runs: { agentId: string; turnKey: string | undefined; rows: NativeChatMessage[] }[] = []
  const lastRun = new Map<string, (typeof runs)[number]>()
  for (const [message, turnKey] of appendedTurns) {
    const agentId = agentJournalItemSubagentId(message)!
    const run = lastRun.get(agentId)
    if (run && run.turnKey === turnKey) {
      run.rows.push(message)
    } else {
      const next = { agentId, turnKey, rows: [message] }
      runs.push(next)
      lastRun.set(agentId, next)
    }
  }
  const lastScope = new Map<string, number>()
  if (runs.length > 0) {
    scopes.forEach((scope, index) => scope.agentId !== null && lastScope.set(scope.agentId, index))
  }
  for (const { agentId, turnKey, rows } of runs) {
    const tail = lastScope.get(agentId) ?? -1
    let index = tail
    if (tail === -1 || !scopes[tail]!.turn || scopes[tail]!.turn!.key !== turnKey) {
      if (tail !== -1 && !scopes[tail]!.turn) {
        return null
      }
      index = scopes.length
      lastScope.set(agentId, index)
      scopes.push({
        agentId,
        offset: agentRowsFor(agentId).length,
        ids: new Set(),
        units: [],
        starts: [],
        turn: { key: turnKey }
      })
    }
    if (!appendTo(index, rows)) {
      return null
    }
  }
  const projection =
    conversation === state.projection.conversation && copiedRows.size === 0
      ? state.projection
      : {
          conversation,
          subagentRows:
            copiedRows.size === 0
              ? state.projection.subagentRows
              : new Map([...state.projection.subagentRows, ...copiedRows])
        }
  return { ...state, input: messages, journal, projection, scopes }
}
