// Every subagent the session's rosters have named, by agent id, as this client heard it.
//
// Folded from every roster row and revision the client receives — pages, older pages, and
// live batches, including revisions of roster rows the item window has trimmed or never
// loaded — and from the entries a page names beside its items for roster rows older than
// it, so a subagent's section keeps its name and state whatever the window holds.
// Rebuilt on every page that replaces the window, so nothing outlives an epoch or a
// reconnect; a removed roster row takes its entries with it, and a newer revision of one
// replaces it, as it does the window's copy, so an agent it stops naming loses its entry.

import type { AgentJournalPosition, AgentJournalRenderItem } from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import {
  agentJournalItemPosition,
  compareAgentJournalPositions
} from './agent-session-journal-position'
import type { AgentSessionHistoryPage, AgentSessionSubagentRosterEntry } from './agent-session-wire'
import { isSubagentGroupBlock, type NativeChatSubagentEntry } from './native-chat-types'

/** One subagent as the first roster row naming it records it. */
export type StructuredAgentSubagentRosterEntry = {
  entry: NativeChatSubagentEntry
  rosterItemId: string
  rosterPosition: AgentJournalPosition
  rosterRevision: number
}

export type StructuredAgentSubagentRoster = ReadonlyMap<string, StructuredAgentSubagentRosterEntry>

export const NO_STRUCTURED_AGENT_SUBAGENT_ROSTER: StructuredAgentSubagentRoster = new Map()

/** Far above any one session's subagents; the oldest-named go first past it. */
const MAX_ROSTER_AGENTS = 512

/** Folds roster rows into `roster`, returning it unchanged when nothing it holds changed. The
 *  first roster naming an agent wins, as sections read it; that row's newer revisions update it. */
export function foldStructuredAgentSubagentRoster(
  roster: StructuredAgentSubagentRoster,
  items: readonly AgentJournalRenderItem[],
  removedItemIds: readonly string[] = [],
  /** A page's `subagentRoster`, absent from older hosts. */
  pageEntries: readonly AgentSessionSubagentRosterEntry[] = []
): StructuredAgentSubagentRoster {
  // A holder, not a `let`: writes happen inside closures, which control-flow narrowing can't see.
  const draft: { next: Map<string, StructuredAgentSubagentRosterEntry> | null } = { next: null }
  const writable = (): Map<string, StructuredAgentSubagentRosterEntry> =>
    (draft.next ??= new Map(roster))
  if (removedItemIds.length > 0) {
    const removed = new Set(removedItemIds)
    for (const [agentId, named] of roster) {
      if (removed.has(named.rosterItemId)) {
        writable().delete(agentId)
      }
    }
  }
  for (const item of items) {
    const named = rosterAgentIds(item)
    if (named === null) {
      continue
    }
    for (const [agentId, held] of draft.next ?? roster) {
      if (
        held.rosterItemId === item.itemId &&
        item.revision > held.rosterRevision &&
        !named.has(agentId)
      ) {
        writable().delete(agentId)
      }
    }
  }
  const take = (candidate: StructuredAgentSubagentRosterEntry): void => {
    const held = (draft.next ?? roster).get(candidate.entry.id)
    const order = held
      ? compareAgentJournalPositions(candidate.rosterPosition, held.rosterPosition)
      : -1
    if (
      order < 0 ||
      (held?.rosterItemId === candidate.rosterItemId &&
        candidate.rosterRevision > held.rosterRevision)
    ) {
      writable().set(candidate.entry.id, candidate)
    }
  }
  for (const named of pageEntries) {
    take({
      entry: named.entry,
      rosterItemId: named.itemId,
      rosterPosition: agentJournalItemPosition(named),
      rosterRevision: named.revision
    })
  }
  for (const item of items) {
    if (!isRootAgentJournalItem(item) || item.body.kind !== 'message') {
      continue
    }
    for (const block of item.body.blocks) {
      if (!isSubagentGroupBlock(block)) {
        continue
      }
      for (const entry of block.agents) {
        take({
          entry,
          rosterItemId: item.itemId,
          rosterPosition: agentJournalItemPosition(item),
          rosterRevision: item.revision
        })
      }
    }
  }
  const next = draft.next
  if (next === null) {
    return roster
  }
  if (next.size > MAX_ROSTER_AGENTS) {
    const newest = [...next].sort(([, a], [, b]) =>
      compareAgentJournalPositions(b.rosterPosition, a.rosterPosition)
    )
    return new Map(newest.slice(0, MAX_ROSTER_AGENTS))
  }
  return next
}

/** The agents a roster row names, or null when the row is not one of the session's rosters. */
function rosterAgentIds(item: AgentJournalRenderItem): ReadonlySet<string> | null {
  if (!isRootAgentJournalItem(item) || item.body.kind !== 'message') {
    return null
  }
  const groups = item.body.blocks.filter(isSubagentGroupBlock)
  return groups.length === 0
    ? null
    : new Set(groups.flatMap((group) => group.agents.map((agent) => agent.id)))
}

/** Folds a history page: its rows, its removals, and the entries it names beside them. */
export function foldStructuredAgentSubagentRosterPage(
  roster: StructuredAgentSubagentRoster | undefined,
  page: AgentSessionHistoryPage
): StructuredAgentSubagentRoster {
  return foldStructuredAgentSubagentRoster(
    roster ?? NO_STRUCTURED_AGENT_SUBAGENT_ROSTER,
    page.items,
    page.removedItemIds,
    page.subagentRoster
  )
}
