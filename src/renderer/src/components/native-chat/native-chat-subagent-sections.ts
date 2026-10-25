// Where each subagent's rows live in the transcript.
//
// A subagent's rows are not the conversation's: they sit in a section of their own,
// keyed by the agent id its roster entry and its rows share. One the session spawned
// opens under the loaded roster row that names it. One another subagent spawned opens
// inside that subagent's section, where its first row happened. One whose roster row
// is not loaded — its spawn is on an older page, or it was never announced — opens
// where its first row happened, in the conversation. Its name and state come from the
// client's roster, which outlives the loaded window; only a subagent no roster ever
// named goes unnamed.

import type { AgentJournalPosition } from '../../../../shared/agent-session-journal-types'
import {
  isSubagentGroupBlock,
  type NativeChatMessage,
  type NativeChatSubagentEntry
} from '../../../../shared/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat-transcript-projection'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import { compareMessages } from './native-chat-session-assembler'

/** Where the roster row naming a subagent sits in the journal. */
export type NativeChatSubagentRosterPlace = {
  rowId: string
  position: AgentJournalPosition | undefined
}

export type NativeChatSubagentSections = {
  /** Each subagent's own rows, by its id. */
  rows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  /** The entry of the first roster naming each subagent: a loaded one, else the client's. */
  entries: ReadonlyMap<string, NativeChatSubagentEntry>
  /** The roster row each entry came from. */
  rosters: ReadonlyMap<string, NativeChatSubagentRosterPlace>
  /** Roster row id → the subagents whose sections open under it, in roster order. */
  anchoredAt: ReadonlyMap<string, readonly string[]>
  /** Every other subagent, by the section it opens in (null: the conversation), in
   *  the order of their first rows. */
  openAt: ReadonlyMap<string | null, readonly string[]>
  /** Row id → the sections enclosing it, outermost first. */
  pathOf: ReadonlyMap<string, readonly string[]>
}

/** What the reader opened (true) or closed (false) by hand: each subagent's section, and
 *  each roster row's list, which hides the sections under that row while it is closed. */
export type NativeChatSubagentChoices = {
  sections: ReadonlyMap<string, boolean>
  rosters: ReadonlyMap<string, boolean>
}

export const NO_NATIVE_CHAT_SUBAGENT_CHOICES: NativeChatSubagentChoices = {
  sections: new Map(),
  rosters: new Map()
}

/** A roster row's list: open or closed, and the children with a section, each open or
 *  closed. An open child's rows follow its entry. */
export type NativeChatSubagentRosterState = {
  open: boolean
  sections: ReadonlyMap<string, boolean>
}

/** A roster's entries, broken after each open section's entry: the roster row draws the
 *  first run, and each later run follows the rows of the child that ended the one before. */
export function nativeChatSubagentEntryRuns(
  agents: readonly NativeChatSubagentEntry[],
  sections: ReadonlyMap<string, boolean>
): NativeChatSubagentEntry[][] {
  let run: NativeChatSubagentEntry[] = []
  const runs = [run]
  for (const agent of agents) {
    run.push(agent)
    if (sections.get(agent.id) === true) {
      run = []
      runs.push(run)
    }
  }
  return runs
}

export type NativeChatSubagentDisclosure = {
  setSectionOpen: (agentId: string, open: boolean) => void
  setRosterOpen: (rosterRowId: string, open: boolean) => void
}

export const NO_NATIVE_CHAT_SUBAGENT_SECTIONS: NativeChatSubagentSections = {
  rows: new Map(),
  entries: new Map(),
  rosters: new Map(),
  anchoredAt: new Map(),
  openAt: new Map(),
  pathOf: new Map()
}

export function nativeChatSubagentSections(
  conversation: readonly NativeChatMessage[],
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>,
  roster?: StructuredAgentSubagentRoster
): NativeChatSubagentSections {
  const rows = new Map(Array.from(subagentRows).filter(([, agentRows]) => agentRows.length > 0))
  if (rows.size === 0) {
    return NO_NATIVE_CHAT_SUBAGENT_SECTIONS
  }
  const entries = new Map<string, NativeChatSubagentEntry>()
  const rosters = new Map<string, NativeChatSubagentRosterPlace>()
  for (const message of conversation) {
    for (const block of message.blocks) {
      if (!isSubagentGroupBlock(block)) {
        continue
      }
      for (const agent of block.agents) {
        if (!entries.has(agent.id) && rows.has(agent.id)) {
          entries.set(agent.id, agent)
          rosters.set(agent.id, { rowId: message.id, position: message.journalPosition })
        }
      }
    }
  }
  // Loaded rosters anchor their sections; the client's names the rest.
  const anchored = new Set(rosters.keys())
  for (const agentId of rows.keys()) {
    const named = anchored.has(agentId) ? undefined : roster?.get(agentId)
    if (named !== undefined) {
      entries.set(agentId, named.entry)
      rosters.set(agentId, { rowId: named.rosterItemId, position: named.rosterPosition })
    }
  }
  const firstRow = (agentId: string): NativeChatMessage => rows.get(agentId)![0]!.message
  // The subagent that spawned this one, when it has a section to hold it.
  const spawnerOf = (agentId: string): string | null => {
    const parent = firstRow(agentId).parentAgentId
    return parent !== undefined && parent !== agentId && rows.has(parent) ? parent : null
  }
  // A chain of spawners that loops back has no outside to open in.
  const scopeOf = (agentId: string): string | null => {
    const spawner = spawnerOf(agentId)
    const seen = new Set([agentId])
    for (let current = spawner; current !== null; current = spawnerOf(current)) {
      if (seen.has(current)) {
        return null
      }
      seen.add(current)
    }
    return spawner
  }
  const scopes = new Map<string, string | null>()
  const openAt = new Map<string | null, string[]>()
  for (const agentId of rows.keys()) {
    const scope = scopeOf(agentId)
    scopes.set(agentId, scope)
    if (scope !== null || !anchored.has(agentId)) {
      const inScope = openAt.get(scope)
      if (inScope) {
        inScope.push(agentId)
      } else {
        openAt.set(scope, [agentId])
      }
    }
  }
  for (const inScope of openAt.values()) {
    inScope.sort((a, b) => compareMessages(firstRow(a), firstRow(b)))
  }
  const anchoredAt = new Map<string, string[]>()
  for (const [agentId, { rowId }] of rosters) {
    if (anchored.has(agentId) && scopes.get(agentId) === null) {
      const anchored = anchoredAt.get(rowId)
      if (anchored) {
        anchored.push(agentId)
      } else {
        anchoredAt.set(rowId, [agentId])
      }
    }
  }
  const paths = new Map<string, readonly string[]>()
  const pathTo = (agentId: string): readonly string[] => {
    const known = paths.get(agentId)
    if (known) {
      return known
    }
    const scope = scopes.get(agentId) ?? null
    const path = scope === null ? [agentId] : [...pathTo(scope), agentId]
    paths.set(agentId, path)
    return path
  }
  const pathOf = new Map<string, readonly string[]>()
  for (const [agentId, agentRows] of rows) {
    const path = pathTo(agentId)
    for (const row of agentRows) {
      pathOf.set(row.message.id, path)
    }
  }
  return { rows, entries, rosters, anchoredAt, openAt, pathOf }
}

/** Every subagent's rows in transcript order: apart from the merge below, so an
 *  update to the conversation alone (the parent streaming) reuses it. */
export function nativeChatSubagentRowsInOrder(
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
): readonly NativeChatSubagentRow[] {
  return Array.from(subagentRows.values())
    .flat()
    .sort((a, b) => compareMessages(a.message, b.message))
}

/** Every row with its turn, the conversation's and each subagent's together, in
 *  transcript order: a subagent's edits are real changes in the turn they happened. */
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
