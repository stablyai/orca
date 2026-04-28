import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  computeDominantState,
  type DashboardRepoGroup,
  type DashboardAgentRow,
  type DashboardWorktreeCard
} from './useDashboardData'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'

// Why: when an agent finishes or its terminal closes, the store cleans up the
// explicit status entry and the agent vanishes from useDashboardData. Retaining
// the last-known "done" snapshot in the store (not in component state) lets the
// dashboard AND the sidebar hovercard render the exact same set of rows — the
// two surfaces must be consistent so the user sees the same completion in both
// places, and dismissal in one reflects in the other.

export function useRetainedAgentsSync(liveGroups: DashboardRepoGroup[]): void {
  const retainAgents = useAppStore((s) => s.retainAgents)
  const pruneRetainedAgents = useAppStore((s) => s.pruneRetainedAgents)
  const clearRetentionSuppressedPaneKeys = useAppStore((s) => s.clearRetentionSuppressedPaneKeys)
  const dashboardEnabled = useAppStore((s) => s.settings?.experimentalAgentDashboard === true)
  const prevAgentsRef = useRef<Map<string, { row: DashboardAgentRow; worktreeId: string }>>(
    new Map()
  )

  useEffect(() => {
    // Why: the experimental-setting gate lives inside the effect (not around
    // the hook declarations above) so rules-of-hooks stays satisfied — the
    // store selectors and useRef must always run. When the dashboard is
    // disabled, skip all retention work to avoid touching the store for a
    // feature the user cannot see. Keeping this check here (rather than in
    // App.tsx) makes the hook self-contained and safe to call unconditionally
    // from any site.
    if (!dashboardEnabled) {
      // Why: reset the previous-agents snapshot while the flag is off so a
      // later off->on toggle (same session, no restart) does not resurrect
      // pre-disable state. Without this, the first post-re-enable run would
      // diff current liveGroups against a stale map captured before the flag
      // flipped off, and collectRetainedAgentsOnDisappear could retroactively
      // retain agents that finished / had their paneKeys reused during the
      // off window — an "agent disappeared while the dashboard was hidden"
      // case must NOT produce a retained row on re-enable.
      prevAgentsRef.current = new Map()
      return
    }
    const current = new Map<string, { row: DashboardAgentRow; worktreeId: string }>()
    const existingWorktreeIds = new Set<string>()
    for (const group of liveGroups) {
      for (const wt of group.worktrees) {
        existingWorktreeIds.add(wt.worktree.id)
        for (const agent of wt.agents) {
          current.set(agent.paneKey, { row: agent, worktreeId: wt.worktree.id })
        }
      }
    }

    // Why: read retention state via getState() instead of subscribing. This
    // effect's driving input is liveGroups — retention decisions only need to
    // happen when an agent appears/disappears from the live set. Subscribing
    // to retainedAgentsByPaneKey would create a feedback loop (this effect
    // calls retainAgents which updates that map, re-firing the effect).
    // retentionSuppressedPaneKeys is only acted on when the corresponding
    // pane disappears from liveGroups, so its changes are naturally picked
    // up on the next liveGroups-driven run via this fresh getState() read.
    const { retainedAgentsByPaneKey: retainedNow, retentionSuppressedPaneKeys } =
      useAppStore.getState()
    const { toRetain, consumedSuppressedPaneKeys } = collectRetainedAgentsOnDisappear({
      previousAgents: prevAgentsRef.current,
      currentAgents: current,
      retainedAgentsByPaneKey: retainedNow,
      retentionSuppressedPaneKeys
    })
    // Why: batch retention into a single store mutation. Looping retainAgent
    // would trigger N set(...) calls and N subscriber notifications when
    // several agents vanish in the same frame (e.g. tab close, worktree
    // teardown), exposing intermediate maps to consumers mid-loop. A single
    // atomic update keeps the dashboard + sidebar hovercard visually stable.
    retainAgents(toRetain)

    prevAgentsRef.current = current
    pruneRetainedAgents(existingWorktreeIds)
    if (consumedSuppressedPaneKeys.length > 0) {
      clearRetentionSuppressedPaneKeys(consumedSuppressedPaneKeys)
    }
  }, [
    liveGroups,
    retainAgents,
    pruneRetainedAgents,
    clearRetentionSuppressedPaneKeys,
    dashboardEnabled
  ])
}

export function useRetainedAgents(liveGroups: DashboardRepoGroup[]): {
  enrichedGroups: DashboardRepoGroup[]
  dismissAgent: (paneKey: string) => void
} {
  // Why: the retention sync runs at App level (see useRetainedAgentsSync in
  // App.tsx) so retained entries persist across dashboard mounts. This hook
  // only reads + dismisses individual rows; bulk worktree-level dismissal
  // was removed because silently dropping retained done agents when the
  // user clicks a worktree can erase completion signals for other agents
  // (e.g. a done Codex row while a live Claude row triggered the click).
  const retained = useAppStore((s) => s.retainedAgentsByPaneKey)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)

  const enrichedGroups = useMemo(
    () => enrichGroupsWithRetained(liveGroups, retained),
    [liveGroups, retained]
  )

  const dismissAgent = useCallback(
    (paneKey: string) => {
      dismissRetainedAgent(paneKey)
    },
    [dismissRetainedAgent]
  )

  return { enrichedGroups, dismissAgent }
}

export function enrichGroupsWithRetained(
  liveGroups: DashboardRepoGroup[],
  retained: Record<string, RetainedAgentEntry>
): DashboardRepoGroup[] {
  const retainedList = Object.values(retained)
  if (retainedList.length === 0) {
    return liveGroups
  }

  const byWorktree = new Map<string, RetainedAgentEntry[]>()
  for (const ra of retainedList) {
    const list = byWorktree.get(ra.worktreeId) ?? []
    list.push(ra)
    byWorktree.set(ra.worktreeId, list)
  }

  // Why: if the same paneKey is both live and retained during a render seam,
  // the live row wins so we never double-render an agent mid-transition.
  const livePaneKeys = new Set<string>()
  for (const group of liveGroups) {
    for (const wt of group.worktrees) {
      for (const agent of wt.agents) {
        livePaneKeys.add(agent.paneKey)
      }
    }
  }

  return liveGroups.map((group) => {
    // Why: preserve reference identity at the group level when no worktree
    // inside it has retained rows. Returning a fresh group/worktrees array
    // unconditionally invalidates downstream React.memo across the entire
    // tree whenever retainedAgentsByPaneKey changes — even for groups whose
    // worktrees are untouched.
    let anyChanged = false
    const worktrees: DashboardWorktreeCard[] = []
    for (const wt of group.worktrees) {
      const retainedForWt = byWorktree
        .get(wt.worktree.id)
        ?.filter((ra) => !livePaneKeys.has(ra.entry.paneKey))
      if (!retainedForWt?.length) {
        worktrees.push(wt)
        continue
      }
      anyChanged = true

      const retainedRows: DashboardAgentRow[] = retainedForWt.map(retainedToRow)

      // Why: re-sort after merging retained rows ascending by startedAt so
      // the list order matches useDashboardData (oldest first, new rows
      // append at the bottom) and doesn't reshuffle rows the user is
      // currently reading.
      const mergedAgents = [...wt.agents, ...retainedRows].sort((a, b) => a.startedAt - b.startedAt)
      worktrees.push({
        ...wt,
        agents: mergedAgents,
        // Why: share computeDominantState with useDashboardData so the
        // dashboard (live-only) and the retained-enriched view apply the
        // exact same blocked > working > done > idle priority. Keeping two
        // copies risks drift where a priority tweak in one surface silently
        // diverges the two — the two surfaces must stay in sync.
        dominantState: computeDominantState(mergedAgents),
        // Why: earliestStartedAt should anchor to the oldest start across live
        // and retained rows — retained entries can be *older* than current
        // live agents (they're what's lingering from a prior run), so the
        // min keeps the worktree's list position stable as retained rows
        // merge in.
        earliestStartedAt: Math.min(
          wt.earliestStartedAt > 0 ? wt.earliestStartedAt : Number.POSITIVE_INFINITY,
          ...retainedForWt.map((ra) => ra.startedAt)
        )
      } satisfies DashboardWorktreeCard)
    }

    if (!anyChanged) {
      return group
    }
    return { ...group, worktrees } satisfies DashboardRepoGroup
  })
}

function retainedToRow(ra: RetainedAgentEntry): DashboardAgentRow {
  return {
    paneKey: ra.entry.paneKey,
    entry: ra.entry,
    tab: ra.tab,
    agentType: ra.agentType,
    state: 'done',
    startedAt: ra.startedAt
  }
}

export function collectRetainedAgentsOnDisappear(args: {
  previousAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  currentAgents: Map<string, { row: DashboardAgentRow; worktreeId: string }>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  retentionSuppressedPaneKeys: Record<string, true>
}): {
  toRetain: RetainedAgentEntry[]
  consumedSuppressedPaneKeys: string[]
} {
  const toRetain: RetainedAgentEntry[] = []
  const consumedSuppressedPaneKeys: string[] = []

  for (const [paneKey, prev] of args.previousAgents) {
    if (args.currentAgents.has(paneKey)) {
      continue
    }
    // Why: skip only when the retained snapshot is for the SAME (or newer) run.
    // A reused paneKey (same tab+pane, fresh agent start after a prior run was
    // retained) produces a newer startedAt — we must overwrite so stale
    // completion data doesn't linger forever for the reused pane.
    const alreadyRetained = args.retainedAgentsByPaneKey[paneKey]
    if (alreadyRetained && alreadyRetained.startedAt >= prev.row.startedAt) {
      continue
    }
    if (args.retentionSuppressedPaneKeys[paneKey]) {
      consumedSuppressedPaneKeys.push(paneKey)
      continue
    }
    // Why: only keep a sticky snapshot when the agent finished cleanly
    // (state === 'done' and not interrupted). Explicit teardown paths mark
    // pane keys as suppression candidates, so a close/quit/crash cannot
    // resurrect a stale `done` row on the next sync.
    const lastState = prev.row.state
    const wasInterrupted = prev.row.entry.interrupted === true
    if (lastState !== 'done' || wasInterrupted) {
      continue
    }
    toRetain.push({
      entry: prev.row.entry,
      worktreeId: prev.worktreeId,
      tab: prev.row.tab,
      agentType: prev.row.agentType,
      startedAt: prev.row.startedAt
    })
  }

  return { toRetain, consumedSuppressedPaneKeys }
}
