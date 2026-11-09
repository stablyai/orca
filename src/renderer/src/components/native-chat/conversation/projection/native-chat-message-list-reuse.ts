import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { sameNativeChatRowPlacement } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatTurnJournal } from '../../../../../../shared/native-chat/transcript/native-chat-turn-membership'
import {
  compareNativeChatDisplayMessages as compareMessages,
  nativeChatDisplaySortRank
} from '../../../../../../shared/native-chat/transcript/native-chat-message-order'
import {
  buildNativeChatFoldUnit,
  groupNativeChatFoldUnitMembers,
  type NativeChatFoldUnit
} from '../../../../../../shared/native-chat/transcript/native-chat-fold-units'
import { nativeChatToolFoldKind } from '../../../../../../shared/native-chat/tools/native-chat-tool-fold'
import { isOrphanRowId } from '../../../../../../shared/native-chat/tools/native-chat-folded-tool-results'
import { subagentItemBlock } from '../../../../../../shared/native-chat/transcript/native-chat-subagent-items'
import { stripNoiseMessages } from '../../../../../../shared/native-chat/native-chat-noise'
import { agentJournalItemSubagentId } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import { compareAgentJournalItems } from '../../../../../../shared/agent-session/journal/agent-session-journal-position'
import { readAgentJournalTurn } from '../../../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  settleUnit,
  unitStarts,
  type NativeChatListScope,
  type NativeChatListState
} from './native-chat-message-list-units'

function isUserMessage(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'message' && item.body.role === 'user'
}

/** Turn keys read user rows, turn records, turn scopes, submissions and the host's latest turn. */
function sameTurnInputs(
  before: NativeChatTurnJournal | null | undefined,
  after: NativeChatTurnJournal | null | undefined
): boolean {
  if (!before || !after) {
    return before === after
  }
  if (
    before.submissions !== after.submissions ||
    before.working !== after.working ||
    JSON.stringify(before.latestTurn) !== JSON.stringify(after.latestTurn) ||
    before.items.length !== after.items.length
  ) {
    return false
  }
  return before.items.every((item, index) => {
    const next = after.items[index]!
    return (
      item === next ||
      (item.itemId === next.itemId &&
        item.agentId === next.agentId &&
        compareAgentJournalItems(item, next) === 0 &&
        item.turnScope?.kind === next.turnScope?.kind &&
        (item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : undefined) ===
          (next.turnScope?.kind === 'turn' ? next.turnScope.turnItemId : undefined) &&
        !readAgentJournalTurn(item.body) &&
        !readAgentJournalTurn(next.body) &&
        !isUserMessage(item) &&
        !isUserMessage(next))
    )
  })
}

/** Revised rows re-fold only their unit, and conversation appends only the last unit onward; else null. */
export function reuseUnits(
  state: NativeChatListState,
  messages: readonly NativeChatMessage[],
  journal: NativeChatTurnJournal | null | undefined
): NativeChatListState | null {
  const before = state.input
  const subagents = state.projection.subagentRows.size > 0
  if (
    !state.ordered ||
    messages.length < before.length ||
    (subagents && (messages.length !== before.length || !sameTurnInputs(state.journal, journal)))
  ) {
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
      nativeChatDisplaySortRank(message) !== 0 ||
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
  let last = before.at(-1)
  for (const message of appended) {
    if (
      !message.journalPosition ||
      nativeChatDisplaySortRank(message) !== 0 ||
      agentJournalItemSubagentId(message) !== null ||
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
  let subagentRows = state.projection.subagentRows
  for (const [prior, message] of changed) {
    const at = state.place.get(prior)
    if (!at) {
      return null
    }
    const scope = edit(at.scope)
    const unit = scope.units[at.unit]!
    // A refused reuse projects in full with fresh maps, so recording sources as we go is safe.
    state.kinds.set(message, state.kinds.get(prior)!)
    const rebuilt = settleUnit(
      buildNativeChatFoldUnit(
        unit.sources.map((source) => (source === prior ? message : source)),
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
    scope.units[at.unit] = rebuilt
    state.kinds.delete(prior)
    state.place.delete(prior)
    state.place.set(message, at)
    if (rebuilt.rows.every((row, index) => row === unit.rows[index])) {
      continue
    }
    const start = scope.offset + scope.starts[at.unit]!
    if (scope.agentId === null) {
      conversation =
        conversation === state.projection.conversation ? conversation.slice() : conversation
      conversation.splice(start, rebuilt.rows.length, ...rebuilt.rows)
    } else {
      const rows = subagentRows.get(scope.agentId)!.slice()
      rebuilt.rows.forEach((row, offset) => {
        rows[start + offset] = { message: row, turnKey: rows[start + offset]!.turnKey }
      })
      subagentRows = new Map(subagentRows).set(scope.agentId, rows)
    }
  }
  if (appended.length > 0) {
    const scope = edit(0)
    if (scope.agentId !== null) {
      return null
    }
    for (const message of appended) {
      state.kinds.set(message, nativeChatToolFoldKind(message))
      state.ids.add(message.id)
      scope.ids.add(message.id)
    }
    // Units start where the scan starts a group, so re-scan from the last head.
    const from = Math.max(0, scope.units.length - 1)
    const head = scope.units[from]
    const units: NativeChatFoldUnit[] = []
    for (const members of groupNativeChatFoldUnitMembers(
      [...(head?.sources ?? []), ...appended],
      state.kinds
    )) {
      const held = members[0] === head?.sources[0] ? head : undefined
      const unit = settleUnit(
        buildNativeChatFoldUnit(members, scope.ids, state.kinds, held, stripNoiseMessages),
        held
      )
      if (unit.orphans.length > 0 || (held && held.orphans.length > 0)) {
        return null
      }
      unit.sources.forEach((source) =>
        state.place.set(source, { scope: 0, unit: from + units.length })
      )
      units.push(unit)
    }
    const start = scope.starts[from] ?? 0
    scope.units.splice(from, scope.units.length - from, ...units)
    scope.starts = [
      ...scope.starts.slice(0, from),
      ...unitStarts(units).map((offset) => start + offset)
    ]
    conversation = [...conversation.slice(0, start), ...units.flatMap((unit) => unit.rows)]
  }
  const projection =
    conversation === state.projection.conversation && subagentRows === state.projection.subagentRows
      ? state.projection
      : { conversation, subagentRows }
  return { ...state, input: messages, journal, projection, scopes }
}
