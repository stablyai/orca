import React, { useCallback } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import type { DashboardAgentRow as DashboardAgentRowType } from '@/components/dashboard/useDashboardData'
import { useNow } from '@/components/dashboard/useNow'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

type AgentStatusHoverProps = {
  worktreeId: string
  children: React.ReactNode
}

// Why: the hovercard renders the exact same information the per-worktree
// dashboard card shows — hook-reported agents plus any retained "done"
// snapshots. The derivation lives in useWorktreeAgentRows so the
// WorktreeCard's inline variant (opt-in via the 'inline-agents' card
// property) can reuse the same rows and stay in lockstep with what this
// hover shows.
const AgentStatusHover = React.memo(function AgentStatusHover({
  worktreeId,
  children
}: AgentStatusHoverProps) {
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const acknowledgeAgents = useAppStore((s) => s.acknowledgeAgents)

  const agents = useWorktreeAgentRows(worktreeId)

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
  // Why: clicking a row acks the specific paneKey so the dashboard's
  // unvisited-bold signal clears for that agent immediately, without
  // waiting for the auto-ack hook's next tick. The hovercard itself
  // renders with isUnvisited={false} (the default) because the preview
  // is transient — bolding prompts here would double-encode with the
  // WorktreeCard's own unread signal that already surfaces this card.
  const handleActivateAgentTab = useCallback(
    (tabId: string, paneKey: string) => {
      acknowledgeAgents([paneKey])
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
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
            />
          </div>
        ))}
      </div>
    </div>
  )
})

export default AgentStatusHover
