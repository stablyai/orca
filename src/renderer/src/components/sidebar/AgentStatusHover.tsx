import React, { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import type { DashboardAgentRow as DashboardAgentRowType } from '@/components/dashboard/useDashboardData'
import { useNow } from '@/components/dashboard/useNow'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { TerminalTab } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

type AgentStatusHoverProps = {
  worktreeId: string
  children: React.ReactNode
}

// Why: stable empty-array references so narrow selectors return the same
// reference when there's nothing for this worktree. Without stable empties,
// zustand's shallow equality would see a new `[]` every render and trigger
// unnecessary re-renders — defeating the purpose of the narrow selector.
const EMPTY_TABS: TerminalTab[] = []
const EMPTY_LIVE_ENTRIES: AgentStatusEntry[] = []
const EMPTY_RETAINED: RetainedAgentEntry[] = []

// Why: the hovercard must render the exact same information the per-worktree
// dashboard card shows — hook-reported agents plus any retained "done"
// snapshots. We intentionally do NOT call useDashboardData() +
// enrichGroupsWithRetained() here, even though that would centralize the row-
// building logic. AgentStatusHover wraps every WorktreeCard, so reusing the
// full dashboard pipeline would mean every agent-status event recomputes the
// entire repo × worktree × tabs × agentStatus aggregation once per card on
// screen — O(worktrees²) work per update (render amplification). Instead we
// read the store's primitive maps via narrow selectors and do a focused
// per-worktree scan that mirrors buildAgentRowsForWorktree in
// useDashboardData.ts and the retained-row merge in useRetainedAgents.ts.
// Retention state itself is still hoisted into the store (see
// useRetainedAgentsSync wired at App level), so dismissing in the hover
// reflects in the dashboard and vice versa.
const AgentStatusHover = React.memo(function AgentStatusHover({
  worktreeId,
  children
}: AgentStatusHoverProps) {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId])
  // Why: narrow the store subscriptions to only THIS worktree's entries via
  // useShallow. AgentStatusHover wraps every WorktreeCard, so subscribing to
  // the whole agentStatusByPaneKey/retainedAgentsByPaneKey map would make every
  // on-screen hovercard re-render on any agent-status update anywhere —
  // O(worktrees²) render amplification. Pre-filtering here means the card only
  // re-renders when something relevant to THIS worktree changes.
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
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const acknowledgeAgents = useAppStore((s) => s.acknowledgeAgents)

  const agents = useMemo<DashboardAgentRowType[]>(() => {
    const rows: DashboardAgentRowType[] = []
    const seenPaneKeys = new Set<string>()
    // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks — same pattern as
    // useDashboardData.
    const now = Date.now()

    // Why: build a tabId -> entries index once instead of re-scanning every
    // agent status entry inside the per-tab loop. paneKey is formatted as
    // `${tabId}:${paneId}`; splitting on the first ':' lets us bucket entries
    // by tab in a single O(N) pass, turning the per-worktree build from
    // O(tabs × statuses) into O(tabs + statuses). Mirrors the same index
    // built in useDashboardData.buildDashboardData. `entries` is already
    // pre-filtered to this worktree by the narrow selector above, so this is
    // O(M) where M is this-worktree-entries, not the global map.
    const entriesByTabId = new Map<string, AgentStatusEntry[]>()
    for (const entry of entries) {
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

    // Live rows — mirror buildAgentRowsForWorktree in useDashboardData.ts.
    const worktreeTabs = tabs ?? []
    for (const tab of worktreeTabs) {
      const explicitEntries = entriesByTabId.get(tab.id) ?? []
      for (const entry of explicitEntries) {
        // Why: decay stale working/blocked/waiting entries to 'idle' when the
        // hook stream has gone silent past AGENT_STATUS_STALE_AFTER_MS. Without
        // this, an agent that exited without a final update would keep the
        // hover's "Running agents" count and the dashboard filters inflated
        // with dead work. `done` is terminal and must NOT decay to idle —
        // retention (collectRetainedAgentsOnDisappear) only keeps rows whose
        // prev state was 'done', so a stale done → idle would silently drop
        // the completion signal. Mirrors useDashboardData.buildAgentRowsForWorktree.
        const isFresh = isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
        const shouldDecay =
          !isFresh &&
          (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
        rows.push({
          paneKey: entry.paneKey,
          entry,
          tab,
          agentType: entry.agentType ?? 'unknown',
          state: shouldDecay ? 'idle' : entry.state,
          // Why: the oldest stateHistory entry's startedAt is the agent's
          // original "first seen" timestamp. When history is empty the entry
          // has never transitioned state, so stateStartedAt (the moment the
          // current — and only — state began) is the true first-seen
          // timestamp. Do NOT fall back to updatedAt: it advances on every
          // tool/prompt ping within the same state, which would corrupt
          // oldest-first ordering and the "started … ago" display for
          // long-running agents between state transitions. Matches
          // useDashboardData's semantics exactly.
          startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
        })
        seenPaneKeys.add(entry.paneKey)
      }
    }

    // Retained rows — mirror enrichGroupsWithRetained: add a retained snapshot
    // only if it belongs to THIS worktree and no live row already occupies its
    // paneKey. `retained` is already pre-filtered to this worktree by the
    // narrow selector above.
    for (const ra of retained) {
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

    // Why: sort oldest-first to match useDashboardData ordering — stable list
    // order keeps new agents from shoving the row the user is reading.
    rows.sort((a, b) => a.startedAt - b.startedAt)
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, entries, retained, worktreeId, agentStatusEpoch])

  // Why: mirror AgentDashboard.handleDismissAgent so dismissing in either
  // surface has identical effect — removes the live store entry and the
  // retained snapshot if either is present.
  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      dropAgentStatus(paneKey)
      dismissRetainedAgent(paneKey)
    },
    [dropAgentStatus, dismissRetainedAgent]
  )

  // Why: clicking a row activates the specific tab the agent runs in. Retained
  // rows can outlive their tab, so fall back to worktree-only activation when
  // the tab is no longer present.
  // Why: symmetric with the dashboard's handleActivateAgent — clicking a row
  // through the sidebar hovercard should fade it to the visited weight
  // immediately, instead of waiting for useAutoAckViewedAgent to catch up once
  // the tab becomes active. Scoped to the single clicked paneKey so sibling
  // rows remain bold.
  const handleActivateAgentTab = useCallback(
    (tabId: string, paneKey: string) => {
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
      acknowledgeAgents([paneKey])
    },
    [worktreeId, setActiveWorktree, setActiveTab, setActiveView, acknowledgeAgents]
  )

  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/* Why: the shared HoverCard uses `border-border/50`, but `--border`
          already carries very different alpha per theme (#e5e5e5 opaque in
          light, rgb(255 255 255 / 0.07) in dark). At /50 the dark-mode edge
          collapses to ~3% alpha and the card looks borderless. Override to
          explicit light/dark tokens so the card outline reads the same in
          both modes. */}
      {/* Why: cap the card to the viewport and let its body scroll. When a row
          is expanded (tool input, prompt, or assistant message unfurled), the
          content can exceed the sidebar's vertical space; without a bounded
          card the hover overflows off-screen with no way to reach the rows
          below. `max-h-[85vh]` + `flex flex-col` keeps the card within the
          viewport, and the inner list below owns the scroll so the "Agent
          activity (N)" header stays pinned. */}
      <HoverCardContent
        side="right"
        align="start"
        className="flex w-72 max-h-[85vh] flex-col border-neutral-200 bg-popover p-3 text-xs dark:border-white/10"
      >
        <AgentStatusHoverContent
          agents={agents}
          onDismiss={handleDismissAgent}
          onActivate={handleActivateAgentTab}
        />
      </HoverCardContent>
    </HoverCard>
  )
})

type AgentStatusHoverContentProps = {
  agents: DashboardAgentRowType[]
  onDismiss: (paneKey: string) => void
  onActivate: (tabId: string, paneKey: string) => void
}

// Why: split out so `useNow(30_000)` only runs while the hovercard body is
// actually mounted. AgentStatusHover wraps EVERY WorktreeCard in the sidebar
// and stays mounted regardless of whether the card is open, so placing the
// timer on the outer component would run one 30s interval per visible
// worktree for the entire session — strictly worse than pre-hoist, since the
// common path is that the user never opens the hovercard. HoverCardContent is
// portaled by Radix and only mounts while open, so rendering this child there
// naturally gates the timer: 0 intervals while closed, exactly 1 per open
// card. The outer component still owns the narrow store subscriptions and the
// `agents` memo so those don't re-run on every open/close, and to preserve
// the render-amplification protection that originally motivated the narrow
// selectors.
const AgentStatusHoverContent = React.memo(function AgentStatusHoverContent({
  agents,
  onDismiss,
  onActivate
}: AgentStatusHoverContentProps) {
  // Why: own one 30s tick per OPEN hovercard instance and thread it to every
  // row we render. Previously each DashboardAgentRow ran its own setInterval,
  // so an N-row hovercard fired N staggered re-renders every cycle. Scoping
  // this to the inner content (which only mounts while the card is open)
  // keeps the overhead bounded to the card the user is actually looking at.
  const now = useNow(30_000)

  // Why: mirrors DashboardWorktreeCard's isAgentUnvisited rule so the
  // hovercard's weight signal stays consistent with the dashboard. Without
  // this, previously-bold attention-needed states (done/waiting/blocked)
  // render muted because DashboardAgentRow's weight is now driven exclusively
  // by isUnvisited.
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const paneKeys = useMemo(() => agents.map((a) => a.paneKey), [agents])
  const ackByPaneKey = useMemo(() => {
    const out: Record<string, number> = {}
    for (const paneKey of paneKeys) {
      out[paneKey] = acknowledgedAgentsByPaneKey[paneKey] ?? 0
    }
    return out
  }, [paneKeys, acknowledgedAgentsByPaneKey])
  const isAgentUnvisited = useCallback(
    (paneKey: string, stateStartedAt: number) => {
      const ackAt = ackByPaneKey[paneKey] ?? 0
      return ackAt < stateStartedAt
    },
    [ackByPaneKey]
  )

  if (agents.length === 0) {
    return <div className="py-1 text-center text-muted-foreground">No agent activity</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Why: "Agent activity" rather than "Running agents" — the list
          now includes retained 'done' snapshots and stale-decayed 'idle'
          rows alongside live working/blocked/waiting agents, so
          "running" would be semantically inaccurate. */}
      <div className="mb-1 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Agent activity ({agents.length})
      </div>
      {/* Why: same reason as the card border above — `divide-border/60`
          on dark `--border` (0.07 alpha) evaluates to ~4% alpha and
          the row separators disappear. Pin explicit light/dark tokens
          so the dividers stay legible in either mode.
          Why scroll here (and not on HoverCardContent): keeping the header
          pinned above a scrolling list preserves the row count as context
          when one row is expanded and pushes the rest below the fold. */}
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-neutral-200 overflow-y-auto dark:divide-white/10">
        {agents.map((agent) => (
          <div key={agent.paneKey} className="py-1">
            <DashboardAgentRow
              agent={agent}
              onDismiss={onDismiss}
              onActivate={onActivate}
              now={now}
              isUnvisited={isAgentUnvisited(agent.paneKey, agent.entry.stateStartedAt)}
            />
          </div>
        ))}
      </div>
    </div>
  )
})

export default AgentStatusHover
