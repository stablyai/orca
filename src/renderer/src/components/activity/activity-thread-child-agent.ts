import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  buildAgentRowLineageTree,
  resolveAgentRowParentPaneKey,
  type AgentLineageSourceRow
} from '../dashboard/agent-row-lineage-model'
import type { ActivityLiveAgentState } from './activity-thread-types'

type ChildAgentLineageEntry = Pick<AgentStatusEntry, 'terminalHandle' | 'orchestration'>

/** Accept full threads or synthetic structural rows without casts; classifier tests pin compatibility. */
export type ChildAgentClassifiableThread = {
  paneKey: string
  /** Non-null while the pane's own turn is live (working, monitoring or waiting on the user). */
  currentAgentState?: ActivityLiveAgentState | null
  currentAgentEntry?: ChildAgentLineageEntry | null
  latestEvent?: { entry: ChildAgentLineageEntry } | null
  events?: readonly { entry: ChildAgentLineageEntry }[]
}

/** Every entry that can carry the pane's orchestration lineage, newest first. */
function candidateEntries(thread: ChildAgentClassifiableThread): ChildAgentLineageEntry[] {
  const entries: ChildAgentLineageEntry[] = []
  if (thread.currentAgentEntry) {
    entries.push(thread.currentAgentEntry)
  }
  if (thread.latestEvent?.entry) {
    entries.push(thread.latestEvent.entry)
  }
  for (const event of thread.events ?? []) {
    entries.push(event.entry)
  }
  return entries
}

function firstReportedTerminalHandle(thread: ChildAgentClassifiableThread): string | undefined {
  for (const entry of candidateEntries(thread)) {
    if (entry.terminalHandle) {
      return entry.terminalHandle
    }
  }
  return undefined
}

/** Reuse dashboard lineage classification: the newest still-resolving parent wins across history. Orphans and cycles remain top-level rather than disappearing behind child filters. A live child stays top-level unless a live ancestor already represents its work: coordinators end their turn while workers run, and running work must keep a row. */
export function collectHiddenChildAgentPaneKeys(
  threads: readonly ChildAgentClassifiableThread[]
): Set<string> {
  const baseRows: AgentLineageSourceRow[] = threads.map((thread) => ({
    paneKey: thread.paneKey,
    entry: { terminalHandle: firstReportedTerminalHandle(thread) }
  }))
  const rowsByPaneKey = new Map<string, AgentLineageSourceRow>()
  for (const row of baseRows) {
    if (!rowsByPaneKey.has(row.paneKey)) {
      rowsByPaneKey.set(row.paneKey, row)
    }
  }
  const paneKeyByTerminalHandle = new Map<string, string>()
  for (const row of baseRows) {
    if (row.entry.terminalHandle && !paneKeyByTerminalHandle.has(row.entry.terminalHandle)) {
      paneKeyByTerminalHandle.set(row.entry.terminalHandle, row.paneKey)
    }
  }

  const rows = threads.map((thread, index) => {
    const base = baseRows[index]
    for (const entry of candidateEntries(thread)) {
      if (!entry.orchestration) {
        continue
      }
      const probe: AgentLineageSourceRow = {
        paneKey: thread.paneKey,
        entry: { terminalHandle: base.entry.terminalHandle, orchestration: entry.orchestration }
      }
      if (resolveAgentRowParentPaneKey(probe, rowsByPaneKey, paneKeyByTerminalHandle)) {
        return probe
      }
    }
    return base
  })

  const tree = buildAgentRowLineageTree(rows)
  const livePaneKeys = new Set<string>()
  for (const thread of threads) {
    if (thread.currentAgentState) {
      livePaneKeys.add(thread.paneKey)
    }
  }
  const hidden = new Set<string>()
  const visited = new Set<string>()
  const pending = tree.rootRows.map((row) => ({
    paneKey: row.paneKey,
    liveAncestor: livePaneKeys.has(row.paneKey)
  }))
  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const child of tree.childrenByParentPaneKey.get(next.paneKey) ?? []) {
      if (visited.has(child.paneKey)) {
        continue
      }
      visited.add(child.paneKey)
      const live = livePaneKeys.has(child.paneKey)
      if (next.liveAncestor || !live) {
        hidden.add(child.paneKey)
      }
      pending.push({ paneKey: child.paneKey, liveAncestor: next.liveAncestor || live })
    }
  }
  return hidden
}
