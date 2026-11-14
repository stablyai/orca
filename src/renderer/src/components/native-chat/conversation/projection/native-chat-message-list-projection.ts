import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  projectNativeChatTranscript,
  type NativeChatSubagentRow,
  type NativeChatTranscriptProjection
} from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  hostStatesTurnScopes,
  type NativeChatTurnJournal
} from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import {
  compareNativeChatDisplayMessages as compareMessages,
  nativeChatDisplaySortRank,
  orderNativeChatDisplayMessages as orderMessages
} from '../../../../../../shared/native-chat/transcript/messages/native-chat-message-order'
import { buildNativeChatFoldUnits } from '../../../../../../shared/native-chat/transcript/folding/native-chat-fold-units'
import {
  nativeChatToolFoldKind,
  type NativeChatToolFoldKind
} from '../../../../../../shared/native-chat/tools/native-chat-tool-fold'
import { foldSubagentItems } from '../../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { stripNoiseMessages } from '../../../../../../shared/native-chat/native-chat-noise'
import { agentJournalItemSubagentId } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import { reuseUnits } from './native-chat-message-list-reuse'
import { subagentTurnKeys } from './native-chat-message-list-turns'
import {
  settleUnit,
  unitStarts,
  type NativeChatListScope,
  type NativeChatListState
} from './native-chat-message-list-units'

function sameRows<T>(
  left: readonly T[] | undefined,
  right: readonly T[],
  same: (a: T, b: T) => boolean
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((item, index) => same(item, right[index]!))
  )
}

const sameSubagentRow = (a: NativeChatSubagentRow, b: NativeChatSubagentRow): boolean =>
  a.message === b.message && a.turnKey === b.turnKey

function projectFully(
  messages: readonly NativeChatMessage[],
  journal: NativeChatTurnJournal | null | undefined,
  previous: NativeChatListState | null
): NativeChatListState {
  const ids = new Set(messages.map((message) => message.id))
  if (ids.size !== messages.length) {
    // Units are keyed by source id; duplicate ids take the plain fold and leave nothing to reuse.
    return {
      input: messages,
      ids,
      journal,
      projection: retainIdentity(
        projectNativeChatTranscript(messages, compareMessages, journal, orderMessages),
        previous?.projection
      ),
      scopes: [],
      place: new Map(),
      kinds: new Map(),
      turnKeys: null,
      ordered: false
    }
  }
  const held = new Map(
    previous?.scopes.flatMap((scope) => scope.units.map((unit) => [unit.sources[0]!.id, unit]))
  )
  const kinds = new Map<NativeChatMessage, NativeChatToolFoldKind>()
  const place = new Map<NativeChatMessage, { scope: number; unit: number }>()
  const scopes: NativeChatListScope[] = []
  const agentRows = new Map<string, number>()
  let ordered = false
  const order = (rows: readonly NativeChatMessage[]) => {
    const sorted = orderMessages(rows)
    ordered = sorted.every(
      (row, index) =>
        row === rows[index] && row.journalPosition && nativeChatDisplaySortRank(row) === 0
    )
    return sorted
  }
  const projectScope = (rows: readonly NativeChatMessage[]): NativeChatMessage[] => {
    const grouped = foldSubagentItems(rows)
    for (const source of grouped) {
      kinds.set(source, previous?.kinds.get(source) ?? nativeChatToolFoldKind(source))
    }
    const ids = new Set(grouped.map((row) => row.id))
    const units = buildNativeChatFoldUnits(grouped, kinds, held, stripNoiseMessages, ids).map(
      (unit) => settleUnit(unit, held.get(unit.sources[0]!.id))
    )
    const agentId = rows[0] ? agentJournalItemSubagentId(rows[0]) : null
    const offset = agentId === null ? 0 : (agentRows.get(agentId) ?? 0)
    const scope = scopes.length
    for (const [index, unit] of units.entries()) {
      for (const source of unit.sources) {
        place.set(source, { scope, unit: index })
      }
    }
    const starts = unitStarts(units)
    const projected = units.flatMap((unit) => unit.rows)
    if (agentId !== null) {
      agentRows.set(agentId, offset + projected.length)
    }
    scopes.push({ agentId, offset, ids, units, starts })
    return projected
  }
  const projected = projectNativeChatTranscript(
    messages,
    compareMessages,
    journal,
    order,
    projectScope
  )
  for (const scope of scopes) {
    const first =
      scope.agentId !== null && scope.units.some((unit) => unit.rows.length > 0)
        ? projected.subagentRows.get(scope.agentId)?.[scope.offset]
        : undefined
    if (first) {
      scope.turn = { key: first.turnKey }
    }
  }
  return {
    input: messages,
    ids,
    journal,
    projection: retainIdentity(projected, previous?.projection),
    scopes,
    place,
    kinds,
    turnKeys:
      journal && hostStatesTurnScopes(journal.items)
        ? projected.subagentRows.size > 0
          ? subagentTurnKeys(projected.subagentRows, journal.items)
          : new Map()
        : null,
    ordered
  }
}

function retainIdentity(
  projected: NativeChatTranscriptProjection,
  previous: NativeChatTranscriptProjection | undefined
): NativeChatTranscriptProjection {
  if (!previous) {
    return projected
  }
  const subagentRows = new Map<string, readonly NativeChatSubagentRow[]>()
  for (const [agentId, rows] of projected.subagentRows) {
    const prior = previous.subagentRows.get(agentId)
    subagentRows.set(agentId, prior && sameRows(prior, rows, sameSubagentRow) ? prior : rows)
  }
  const sameConversation = sameRows(previous.conversation, projected.conversation, Object.is)
  const sameSubagents =
    subagentRows.size === previous.subagentRows.size &&
    Array.from(subagentRows).every(([agentId, rows]) => previous.subagentRows.get(agentId) === rows)
  if (sameConversation && sameSubagents) {
    return previous
  }
  return {
    conversation: sameConversation ? previous.conversation : projected.conversation,
    subagentRows: sameSubagents ? previous.subagentRows : subagentRows
  }
}

export function createNativeChatMessageListProjection(): (
  messages: NativeChatMessage[],
  journal?: NativeChatTurnJournal | null
) => NativeChatTranscriptProjection {
  let state: NativeChatListState | null = null
  return (messages, journal) => {
    state =
      (state && reuseUnits(state, messages, journal)) ?? projectFully(messages, journal, state)
    return state.projection
  }
}
