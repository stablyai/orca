// A transcript shows one scope: the conversation, or one subagent's own rows. Subagents open in their own view, never inline.

import { compareAgentJournalPositions } from '../../../../../shared/agent-session/journal/agent-session-journal-position'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import {
  isSubagentGroupBlock,
  type NativeChatMessage,
  type NativeChatSubagentEntry
} from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { compareNativeChatDisplayMessages as compareMessages } from '../../../../../shared/native-chat/transcript/native-chat-message-order'

const NO_HEADS: readonly NativeChatSubagentHead[] = []

/** A subagent no roster row in its scope names: it opens from a head at its first row. */
export type NativeChatSubagentHead = {
  agentId: string
  entry: NativeChatSubagentEntry | undefined
  first: NativeChatSubagentRow
}

function* rosterAgents(rows: readonly NativeChatMessage[]): Generator<NativeChatSubagentEntry> {
  for (const message of rows) {
    for (const block of message.blocks) {
      if (isSubagentGroupBlock(block)) {
        yield* block.agents
      }
    }
  }
}

/** Every subagent the session names, oldest roster first: a loaded roster's entry, else the client's. */
export function nativeChatSubagentEntries(
  conversation: readonly NativeChatMessage[],
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>,
  roster?: StructuredAgentSubagentRoster
): ReadonlyMap<string, NativeChatSubagentEntry> {
  const loaded = new Map<string, NativeChatSubagentEntry>()
  const take = (rows: readonly NativeChatMessage[]): void => {
    for (const agent of rosterAgents(rows)) {
      if (!loaded.has(agent.id)) {
        loaded.set(agent.id, agent)
      }
    }
  }
  take(conversation)
  for (const rows of subagentRows.values()) {
    take(rows.map(({ message }) => message))
  }
  const position = (agentId: string) => roster?.get(agentId)?.rosterPosition
  const ids = Array.from(new Set([...(roster?.keys() ?? []), ...loaded.keys()])).sort((a, b) => {
    const [left, right] = [position(a), position(b)]
    return left && right ? compareAgentJournalPositions(left, right) : left ? -1 : right ? 1 : 0
  })
  return new Map(
    ids.map((agentId) => [agentId, loaded.get(agentId) ?? roster!.get(agentId)!.entry])
  )
}

/** The subagent that spawned this one, when its rows are loaded; null for the session's own agent. */
function spawnerOf(
  agentId: string,
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
): string | null {
  const parent = subagentRows.get(agentId)?.[0]?.message.parentAgentId
  return parent !== undefined && parent !== agentId && subagentRows.has(parent) ? parent : null
}

/** The spawn chain down to a subagent, outermost first; a loop stops at the first repeat. */
export function nativeChatSubagentChain(
  agentId: string,
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
): readonly string[] {
  const chain = [agentId]
  for (
    let spawner = spawnerOf(agentId, subagentRows);
    spawner !== null && !chain.includes(spawner);
    spawner = spawnerOf(spawner, subagentRows)
  ) {
    chain.unshift(spawner)
  }
  return chain
}

/** Subagents the scope's agent (null: the session's) spawned that no roster row in `scopeRows` names. */
export function nativeChatSubagentHeads(
  scopeRows: readonly NativeChatMessage[],
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>,
  entries: ReadonlyMap<string, NativeChatSubagentEntry>,
  scopeAgentId: string | null
): readonly NativeChatSubagentHead[] {
  if (subagentRows.size === 0) {
    return NO_HEADS
  }
  const named = new Set(Array.from(rosterAgents(scopeRows), ({ id }) => id))
  const heads: NativeChatSubagentHead[] = []
  for (const [agentId, rows] of subagentRows) {
    const first = rows[0]
    if (
      first !== undefined &&
      !named.has(agentId) &&
      agentId !== scopeAgentId &&
      spawnerOf(agentId, subagentRows) === scopeAgentId
    ) {
      heads.push({ agentId, entry: entries.get(agentId), first })
    }
  }
  return heads.sort((a, b) => compareMessages(a.first.message, b.first.message))
}

/** Sort child rows separately so parent-only streaming updates reuse their order. */
export function nativeChatSubagentRowsInOrder(
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
): readonly NativeChatSubagentRow[] {
  return Array.from(subagentRows.values())
    .flat()
    .sort((a, b) => compareMessages(a.message, b.message))
}

/** Merge parent and child rows in transcript order so child edits remain in their actual turns. */
export function nativeChatRowsInTranscriptOrder(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  subagentRows: readonly NativeChatSubagentRow[]
): { messages: readonly NativeChatMessage[]; turnKeys: readonly (string | undefined)[] } {
  if (subagentRows.length === 0) {
    return { messages, turnKeys }
  }
  const merged: NativeChatMessage[] = []
  const mergedTurnKeys: (string | undefined)[] = []
  let next = 0
  for (const [index, message] of messages.entries()) {
    while (
      next < subagentRows.length &&
      compareMessages(subagentRows[next]!.message, message) < 0
    ) {
      merged.push(subagentRows[next]!.message)
      mergedTurnKeys.push(subagentRows[next]!.turnKey)
      next += 1
    }
    merged.push(message)
    mergedTurnKeys.push(turnKeys[index])
  }
  for (const row of subagentRows.slice(next)) {
    merged.push(row.message)
    mergedTurnKeys.push(row.turnKey)
  }
  return { messages: merged, turnKeys: mergedTurnKeys }
}
