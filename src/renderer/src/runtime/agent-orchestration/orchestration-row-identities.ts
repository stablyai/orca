import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import {
  getStructuredAgentSessionTabs,
  getStructuredAgentSessionTabsInWorkspace,
  structuredTabPaneKey,
  type StructuredTab
} from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { chatPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs
} from '../native-chat/session-ownership/structured-agent-session-owner'

export type RowIdentities = {
  aliases: Map<string, string>
  canonical: Map<string, { key: string; host: string | null }>
  worktrees: Map<string, string>
}
type RowEntry = {
  tabId: string
  sessionId: string
  worktreeId: string
  actual: string
  key: string
  host: string | null
}
/** Live chat rows by workspace, so a one-workspace tab write re-reads only that workspace. */
type RowLedger = {
  source: TabsByWorktree
  structuredTabs: readonly StructuredTab[]
  ownerInputs: unknown[]
  byWorkspace: Map<string, RowEntry[]>
  actualCounts: Map<string, number>
  aliasCounts: Map<string, number>
  rows: RowIdentities
}
type TabsByWorktree = Record<string, Tab[]>
type RowState = WorktreeRuntimeOwnerState & { unifiedTabsByWorktree?: TabsByWorktree }
const EMPTY: TabsByWorktree = {}
let rowLedger: RowLedger | undefined
let visits = 0
let paneKeyEncodes = 0
export function orchestrationRowWorkForTest(): { visits: number; paneKeyEncodes: number } {
  return { visits, paneKeyEncodes }
}
export const aliasKey = (host: string, key: string) => `${host}\0${key}`
const reuseKey = (tabId: string, sessionId: string) => `${tabId}\0${sessionId}`
const sameInputs = (a: unknown[], b: unknown[]) => a.every((value, index) => value === b[index])

// Why: a live chat keeps its pane ids from the last build; only a new chat hashes its session id.
function rowEntry(state: RowState, tab: StructuredTab, reuse: Map<string, RowEntry>): RowEntry {
  visits++
  const host = structuredAgentSessionOwnerForTab(state, tab)
  const previous = reuse.get(reuseKey(tab.id, tab.entityId))
  if (previous && previous.host === host && previous.worktreeId === tab.worktreeId) {
    return previous
  }
  if (!previous) {
    paneKeyEncodes++
  }
  return {
    tabId: tab.id,
    sessionId: tab.entityId,
    worktreeId: tab.worktreeId,
    actual: previous?.actual ?? structuredTabPaneKey(tab),
    key: previous?.key ?? chatPaneKey(tab.entityId),
    host
  }
}

function rebuildRows(
  state: RowState,
  source: TabsByWorktree,
  structuredTabs: readonly StructuredTab[],
  ownerInputs: unknown[],
  previous: RowLedger | undefined
): RowLedger {
  const reuse = new Map<string, RowEntry>()
  for (const entries of previous?.byWorkspace.values() ?? []) {
    for (const entry of entries) {
      reuse.set(reuseKey(entry.tabId, entry.sessionId), entry)
    }
  }
  const ledger: RowLedger = {
    source,
    structuredTabs,
    ownerInputs,
    byWorkspace: new Map(),
    actualCounts: new Map(),
    aliasCounts: new Map(),
    rows: { aliases: new Map(), canonical: new Map(), worktrees: new Map() }
  }
  const { aliases, canonical, worktrees } = ledger.rows
  for (const tab of structuredTabs) {
    if (!tab.entityId) {
      visits++
      continue
    }
    const entry = rowEntry(state, tab, reuse)
    const bucket = ledger.byWorkspace.get(tab.worktreeId)
    if (bucket) {
      bucket.push(entry)
    } else {
      ledger.byWorkspace.set(tab.worktreeId, [entry])
    }
    canonical.set(entry.actual, { key: entry.key, host: entry.host })
    worktrees.set(entry.actual, entry.worktreeId)
    ledger.actualCounts.set(entry.actual, (ledger.actualCounts.get(entry.actual) ?? 0) + 1)
    if (entry.host) {
      const alias = aliasKey(entry.host, entry.key)
      ledger.aliasCounts.set(alias, (ledger.aliasCounts.get(alias) ?? 0) + 1)
      if (!aliases.has(alias)) {
        aliases.set(alias, entry.actual)
      }
    }
  }
  return ledger
}

/** False when the change can only be placed by a rebuild. */
function applyRowChanges(
  ledger: RowLedger,
  state: RowState,
  source: TabsByWorktree,
  workspaceIds: ReadonlySet<string>
): boolean {
  const reuse = new Map<string, RowEntry>()
  const before: RowEntry[] = []
  for (const worktreeId of workspaceIds) {
    for (const entry of ledger.byWorkspace.get(worktreeId) ?? []) {
      reuse.set(reuseKey(entry.tabId, entry.sessionId), entry)
      before.push(entry)
    }
  }
  const next = new Map<string, RowEntry[]>()
  const after: RowEntry[] = []
  for (const worktreeId of workspaceIds) {
    const entries: RowEntry[] = []
    for (const tab of getStructuredAgentSessionTabsInWorkspace(source, worktreeId)) {
      if (!tab.entityId) {
        visits++
        continue
      }
      const entry = rowEntry(state, tab, reuse)
      entries.push(entry)
      after.push(entry)
    }
    next.set(worktreeId, entries)
  }
  const kept = new Set(after)
  const held = new Set(before)
  const removed = before.filter((entry) => !kept.has(entry))
  const added = after.filter((entry) => !held.has(entry))
  // Shared panes and aliases resolve by list order, which only a rebuild sees.
  const actualDelta = new Map<string, number>()
  const aliasDelta = new Map<string, number>()
  for (const [entries, delta] of [
    [removed, -1],
    [added, 1]
  ] as const) {
    for (const entry of entries) {
      actualDelta.set(entry.actual, (actualDelta.get(entry.actual) ?? 0) + delta)
      if (entry.host) {
        const alias = aliasKey(entry.host, entry.key)
        aliasDelta.set(alias, (aliasDelta.get(alias) ?? 0) + delta)
      }
    }
  }
  const unique = (counts: Map<string, number>, deltas: Map<string, number>) =>
    [...deltas].every(([key, delta]) => {
      const count = counts.get(key) ?? 0
      return count <= 1 && count + delta <= 1
    })
  // Kept rows that share a key pick their winner by order, so only their reorder needs a rebuild.
  const shared = (entry: RowEntry) =>
    (ledger.actualCounts.get(entry.actual) ?? 0) > 1 ||
    (!!entry.host && (ledger.aliasCounts.get(aliasKey(entry.host, entry.key)) ?? 0) > 1)
  const sharedBefore = before.filter((entry) => kept.has(entry) && shared(entry))
  const sharedAfter = after.filter((entry) => held.has(entry) && shared(entry))
  if (
    sharedBefore.some((entry, index) => entry !== sharedAfter[index]) ||
    !unique(ledger.actualCounts, actualDelta) ||
    !unique(ledger.aliasCounts, aliasDelta)
  ) {
    return false
  }
  const { aliases, canonical, worktrees } = ledger.rows
  const adjust = (counts: Map<string, number>, key: string, delta: number) => {
    const count = (counts.get(key) ?? 0) + delta
    if (count) {
      counts.set(key, count)
    } else {
      counts.delete(key)
    }
  }
  for (const [worktreeId, entries] of next) {
    if (entries.length) {
      ledger.byWorkspace.set(worktreeId, entries)
    } else {
      ledger.byWorkspace.delete(worktreeId)
    }
  }
  if (!removed.length && !added.length) {
    return true
  }
  for (const entry of removed) {
    canonical.delete(entry.actual)
    worktrees.delete(entry.actual)
    adjust(ledger.actualCounts, entry.actual, -1)
    if (entry.host) {
      const alias = aliasKey(entry.host, entry.key)
      aliases.delete(alias)
      adjust(ledger.aliasCounts, alias, -1)
    }
  }
  for (const entry of added) {
    canonical.set(entry.actual, { key: entry.key, host: entry.host })
    worktrees.set(entry.actual, entry.worktreeId)
    adjust(ledger.actualCounts, entry.actual, 1)
    if (entry.host) {
      const alias = aliasKey(entry.host, entry.key)
      aliases.set(alias, entry.actual)
      adjust(ledger.aliasCounts, alias, 1)
    }
  }
  // A new object invalidates the projection; the maps stay the single live copy.
  ledger.rows = { aliases, canonical, worktrees }
  return true
}

export function rowIdentities(state: RowState): RowIdentities {
  const source = state.unifiedTabsByWorktree ?? EMPTY
  // The chat list keeps its identity across terminal-only writes, so a title leaves rows cached.
  const structuredTabs = getStructuredAgentSessionTabs(source)
  const ownerInputs = structuredAgentSessionOwnerInputs(state)
  const owned = rowLedger !== undefined && sameInputs(ownerInputs, rowLedger.ownerInputs)
  if (rowLedger && owned && rowLedger.structuredTabs === structuredTabs) {
    rowLedger.source = source
    return rowLedger.rows
  }
  const changes = rowLedger && owned ? readTabMapChanges(source, rowLedger.source) : null
  if (
    rowLedger &&
    changes?.kind === 'addressed' &&
    applyRowChanges(rowLedger, state, source, changes.workspaceIds)
  ) {
    rowLedger.source = source
    rowLedger.structuredTabs = structuredTabs
    return rowLedger.rows
  }
  rowLedger = rebuildRows(state, source, structuredTabs, ownerInputs, rowLedger)
  return rowLedger.rows
}
