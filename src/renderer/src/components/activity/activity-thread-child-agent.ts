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

/** Reuse dashboard lineage classification: the newest still-resolving parent wins across history. Orphans and cycles remain top-level rather than disappearing behind child filters. A live child is never hidden, whatever its ancestors are doing: a row's visibility depends only on that chat's own state. */
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

  const livePaneKeys = new Set(
    threads.filter((thread) => thread.currentAgentState).map((thread) => thread.paneKey)
  )
  const hidden = new Set<string>()
  for (const paneKey of buildAgentRowLineageTree(rows).childPaneKeys) {
    if (!livePaneKeys.has(paneKey)) {
      hidden.add(paneKey)
    }
  }
  return hidden
}
