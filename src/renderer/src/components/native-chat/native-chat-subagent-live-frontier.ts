// Which subagent sections a running scope holds open by default.
//
// A scope's live frontier is the newest row its agent produced, user rows aside, judged by
// the newest call a folded tool run holds rather than where the run is drawn. A section opens
// while that row is part of its agent's delegation: a call that spawns, waits on or messages
// it (a call naming several delegates to the first), or the roster row that names it as the
// agent most recently added. A spawn call naming no agent belongs to the roster announcing
// it. Anything newer supersedes the delegation even while the agent still works; its roster
// keeps showing that live state.
// The session is the outer scope; a subagent still working is a scope of its own for the
// sections it spawned, and a settled one closes its scope. A delegation naming only agents
// one subagent spawned is that subagent's output, wherever the host journaled it. Derived
// every render, with no latch; the reader's own choice outranks it.

import { compareAgentJournalPositions } from '../../../../shared/agent-session-journal-position'
import type { AgentJournalPosition } from '../../../../shared/agent-session-journal-types'
import { normalizeSubagentState } from '../../../../shared/native-chat-subagent-summary'
import { nativeChatRowRendersContent } from '../../../../shared/native-chat-row-content'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { compareMessages } from './native-chat-session-assembler'
import { nativeChatSubagentDelegation } from './native-chat-subagent-delegation'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'

const NONE: ReadonlySet<string> = new Set()

/** A row the reader sees the scope's agent produce. */
function isOutput(message: NativeChatMessage): boolean {
  return message.role !== 'user' && nativeChatRowRendersContent(message.blocks)
}

/** `scopeActive`: the session is running. */
export function nativeChatSubagentLiveSections(
  conversation: readonly NativeChatMessage[],
  sections: NativeChatSubagentSections,
  scopeActive: boolean
): ReadonlySet<string> {
  if (!scopeActive || sections.rows.size === 0) {
    return NONE
  }
  // Each sectioned agent's scope: null for the session's, else the subagent that spawned it.
  const scopeOf = new Map<string, string | null>()
  for (const agentIds of sections.anchoredAt.values()) {
    agentIds.forEach((agentId) => scopeOf.set(agentId, null))
  }
  for (const [scope, agentIds] of sections.openAt) {
    agentIds.forEach((agentId) => scopeOf.set(agentId, scope))
  }
  const handedDown = handDownNestedDelegations(conversation, scopeOf)
  const live = new Set<string>()
  const visit = (scopeRows: readonly NativeChatMessage[], scope: string | null): void => {
    const members =
      scope === null
        ? [...Array.from(sections.anchoredAt.values()).flat(), ...(sections.openAt.get(null) ?? [])]
        : (sections.openAt.get(scope) ?? [])
    const inScope = new Set(members)
    const belongsHere = (agentId: string): boolean =>
      !scopeOf.has(agentId) || scopeOf.get(agentId) === scope
    const atFrontier = (): readonly string[] => {
      for (const row of newestFirst(scopeRows)) {
        if (!isOutput(row) || (scope === null && handedDown.rowIds.has(row.id))) {
          continue
        }
        const delegation = nativeChatSubagentDelegation(row)
        if (delegation?.kind === 'spawn') {
          continue
        }
        if (delegation === null) {
          return []
        }
        if (delegation.kind === 'call') {
          return inScope.has(delegation.agentId) ? [delegation.agentId] : []
        }
        const newest = delegation.agentIds.findLast(belongsHere)
        return newest !== undefined && inScope.has(newest) ? [newest] : []
      }
      // Nothing loaded since the newest roster naming this scope's agents.
      const rostered = members.filter((agentId) => sections.rosters.has(agentId))
      const newest = rostered.reduce<string | undefined>(
        (best, agentId) =>
          best === undefined || compareAddedAt(sections, agentId, best) > 0 ? agentId : best,
        undefined
      )
      return newest === undefined ? [] : [newest]
    }
    atFrontier().forEach((agentId) => live.add(agentId))
    for (const agentId of members) {
      const entry = sections.entries.get(agentId)
      if (entry !== undefined && normalizeSubagentState(entry.state) === 'working') {
        const own = (sections.rows.get(agentId) ?? []).map((row) => row.message)
        const extra = handedDown.byScope.get(agentId)
        visit(extra ? [...own, ...extra].sort(compareMessages) : own, agentId)
      }
    }
  }
  visit(conversation, null)
  return live
}

/** Rows by their newest part, newest first. A tool run is drawn at the assistant row it
 *  folds into, so that row can hold calls newer than the roster rows drawn below it. No
 *  row above an assistant row reaches past it: a run folds only into the latest one. */
function* newestFirst(rows: readonly NativeChatMessage[]): Generator<NativeChatMessage> {
  let below: NativeChatMessage[] = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.role !== 'assistant') {
      below.push(row)
      continue
    }
    const newest = row.foldedJournalPosition ?? row.journalPosition
    let next = 0
    while (next < below.length && (newest === undefined || isNewerThan(below[next]!, newest))) {
      yield below[next]!
      next += 1
    }
    yield row
    yield* below.slice(next)
    below = []
  }
  yield* below
}

/** A row the journal does not hold yet is newer than any it does. */
function isNewerThan(row: NativeChatMessage, position: AgentJournalPosition): boolean {
  return (
    row.journalPosition === undefined ||
    compareAgentJournalPositions(row.journalPosition, position) > 0
  )
}

/** The session's roster rows and calls whose agents one subagent spawned, by that subagent. */
function handDownNestedDelegations(
  conversation: readonly NativeChatMessage[],
  scopeOf: ReadonlyMap<string, string | null>
): { rowIds: ReadonlySet<string>; byScope: ReadonlyMap<string, readonly NativeChatMessage[]> } {
  const rowIds = new Set<string>()
  const byScope = new Map<string, NativeChatMessage[]>()
  if (!Array.from(scopeOf.values()).some((scope) => scope !== null)) {
    return { rowIds, byScope }
  }
  for (const message of conversation) {
    const delegation = nativeChatSubagentDelegation(message)
    if (delegation === null || delegation.kind === 'spawn') {
      continue
    }
    const agentIds = delegation.kind === 'call' ? [delegation.agentId] : delegation.agentIds
    const spawners = new Set(
      agentIds.flatMap((agentId) => (scopeOf.has(agentId) ? [scopeOf.get(agentId) ?? null] : []))
    )
    const [spawner] = spawners
    if (spawners.size === 1 && spawner !== undefined && spawner !== null) {
      rowIds.add(message.id)
      const rows = byScope.get(spawner)
      if (rows) {
        rows.push(message)
      } else {
        byScope.set(spawner, [message])
      }
    }
  }
  return { rowIds, byScope }
}

/** Later roster first; within one roster, the agent whose rows began later. */
function compareAddedAt(sections: NativeChatSubagentSections, a: string, b: string): number {
  const at = (agentId: string) => sections.rosters.get(agentId)?.position
  const [rosterA, rosterB] = [at(a), at(b)]
  if (rosterA !== undefined && rosterB !== undefined) {
    const byRoster = compareAgentJournalPositions(rosterA, rosterB)
    if (byRoster !== 0) {
      return byRoster
    }
  } else if (rosterA !== rosterB) {
    return rosterA === undefined ? -1 : 1
  }
  return compareMessages(sections.rows.get(a)![0]!.message, sections.rows.get(b)![0]!.message)
}
