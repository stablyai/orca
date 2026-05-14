import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { TerminalTab } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

// Why: stable empty-array references so narrow selectors return the same
// reference when there's nothing for this worktree. Without stable empties,
// zustand's shallow equality would see a new `[]` every render and trigger
// unnecessary re-renders — defeating the purpose of the narrow selector.
const EMPTY_TABS: TerminalTab[] = []
const EMPTY_LIVE_ENTRIES: AgentStatusEntry[] = []
const EMPTY_RETAINED: RetainedAgentEntry[] = []

export function buildWorktreeAgentRows(args: {
  tabs: TerminalTab[]
  entries: AgentStatusEntry[]
  retained: RetainedAgentEntry[]
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const seenPaneKeys = new Set<string>()

  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of args.entries) {
    const colonIndex = entry.paneKey.indexOf(':')
    if (colonIndex === -1) {
      continue
    }
    const tabId = entry.paneKey.slice(0, colonIndex)
    const bucket = entriesByTabId.get(tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      entriesByTabId.set(tabId, [entry])
    }
  }

  for (const tab of args.tabs) {
    const explicitEntries = entriesByTabId.get(tab.id) ?? []
    for (const entry of explicitEntries) {
      const isFresh = isExplicitAgentStatusFresh(entry, args.now, AGENT_STATUS_STALE_AFTER_MS)
      const shouldDecay =
        !isFresh &&
        (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
      rows.push({
        paneKey: entry.paneKey,
        entry,
        tab,
        agentType: entry.agentType ?? 'unknown',
        state: shouldDecay ? 'idle' : entry.state,
        startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
      })
      seenPaneKeys.add(entry.paneKey)
    }
  }

  for (const ra of args.retained) {
    if (seenPaneKeys.has(ra.entry.paneKey)) {
      continue
    }
    rows.push({
      paneKey: ra.entry.paneKey,
      entry: ra.entry,
      tab: ra.tab,
      agentType: ra.agentType,
      state: 'done',
      startedAt: ra.startedAt
    })
  }

  rows.sort((a, b) => a.startedAt - b.startedAt)
  return rows
}

/**
 * Narrow per-worktree agent row hook used by the WorktreeCard inline agents
 * list. Produces live hook-reported agents plus retained "done" snapshots,
 * stale-decayed to 'idle' when the hook stream has gone quiet.
 *
 * Uses per-worktree selectors rather than reusing useDashboardData's
 * cross-worktree aggregate — that pipeline is O(repos × worktrees × agents)
 * and would recompute once per sidebar card on every agent-status event.
 * Scoped selectors keep the cost O(this-worktree-entries) per card.
 */
export function useWorktreeAgentRows(worktreeId: string): DashboardAgentRow[] {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId])
  // Why: narrow the subscriptions to only THIS worktree's entries via
  // useShallow. Subscribing to the whole agentStatusByPaneKey map would make
  // every on-screen card re-render on any agent-status update anywhere —
  // O(worktrees²) render amplification. Pre-filtering here means the card
  // only re-renders when something relevant to THIS worktree changes.
  const entries = useAppStore(
    useShallow((s) => {
      const wtTabs = s.tabsByWorktree[worktreeId] ?? EMPTY_TABS
      if (wtTabs.length === 0) {
        return EMPTY_LIVE_ENTRIES
      }
      const tabIds = new Set(wtTabs.map((t) => t.id))
      const out: AgentStatusEntry[] = []
      for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
        const sepIdx = paneKey.indexOf(':')
        if (sepIdx <= 0) {
          continue
        }
        const tabId = paneKey.slice(0, sepIdx)
        if (!tabIds.has(tabId)) {
          continue
        }
        out.push(entry)
      }
      return out.length > 0 ? out : EMPTY_LIVE_ENTRIES
    })
  )
  const retained = useAppStore(
    useShallow((s) => {
      const out: RetainedAgentEntry[] = []
      for (const ra of Object.values(s.retainedAgentsByPaneKey)) {
        if (ra.worktreeId === worktreeId) {
          out.push(ra)
        }
      }
      return out.length > 0 ? out : EMPTY_RETAINED
    })
  )
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries
  // expire, even if no new PTY data arrives — same rationale as
  // useDashboardData.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo<DashboardAgentRow[]>(() => {
    // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks — same pattern as
    // useDashboardData.
    return buildWorktreeAgentRows({
      tabs: tabs ?? [],
      entries,
      retained,
      now: Date.now()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, entries, retained, agentStatusEpoch])
}
