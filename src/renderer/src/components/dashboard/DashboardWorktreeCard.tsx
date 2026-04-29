import React, { useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import DashboardAgentRow from './DashboardAgentRow'
import type { DashboardWorktreeCard as DashboardWorktreeCardData } from './useDashboardData'

type Props = {
  card: DashboardWorktreeCardData
  /** True when this worktree is the one the user is currently viewing. */
  isActive: boolean
  /**
   * Why: accepts the worktree id (not a SyntheticEvent) so the parent can pass
   * a single stable callback shared across all cards instead of minting a
   * fresh `() => setFocusedWorktreeId(id)` closure per card per render — that
   * inline lambda would invalidate React.memo on every AgentDashboard render.
   */
  onFocus: (worktreeId: string) => void
  onDismissAgent: (paneKey: string) => void
  /** Navigate to a specific tab inside this card's worktree. */
  onActivateAgentTab: (worktreeId: string, tabId: string) => void
  isLast: boolean
  /**
   * Why: `now` is owned by the dashboard container and threaded through every
   * card to its rows. One shared 30s tick re-renders all visible "Xm ago"
   * labels instead of each row owning its own setInterval (which would fire N
   * times per cycle, staggered by mount time).
   */
  now: number
}

const DashboardWorktreeCard = React.memo(function DashboardWorktreeCard({
  card,
  isActive,
  onFocus,
  onDismissAgent,
  onActivateAgentTab,
  isLast,
  now
}: Props) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const acknowledgeAgents = useAppStore((s) => s.acknowledgeAgents)

  const paneKeys = useMemo(() => card.agents.map((a) => a.paneKey), [card.agents])
  // Why: subscribe to the ack map's single reference (cheap Object.is check
  // via Zustand's default equality) and derive the per-card slice locally.
  // A useShallow selector here would allocate a fresh object on every
  // store change — including unrelated ones like terminal output —
  // multiplied across every card on screen. Reading the reference and
  // memoizing the per-card slice collapses that to one allocation per
  // card per genuine ack change. acknowledgeAgents in ui.ts preserves the
  // map reference when no ack is actually moving forward, so unrelated
  // clicks do not invalidate this memo either.
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const ackByPaneKey = useMemo(() => {
    const out: Record<string, number> = {}
    for (const paneKey of paneKeys) {
      out[paneKey] = acknowledgedAgentsByPaneKey[paneKey] ?? 0
    }
    return out
  }, [paneKeys, acknowledgedAgentsByPaneKey])

  // Why: an agent counts as "unvisited" when it has no ack OR the agent's
  // current state began after the last ack (a new turn/state transition is
  // a fresh signal the user hasn't seen). Using stateStartedAt (not
  // updatedAt) means within-state tool/prompt pings don't re-trigger the
  // unread highlight; only genuine state changes do.
  const isAgentUnvisited = useCallback(
    (paneKey: string, stateStartedAt: number) => {
      const ackAt = ackByPaneKey[paneKey] ?? 0
      return ackAt < stateStartedAt
    },
    [ackByPaneKey]
  )

  // Why: clicking a worktree row navigates AND acknowledges every agent
  // currently shown under it. The user looking at the card counts as
  // "seeing" all its rows, even ones they don't click individually —
  // otherwise a workspace with five done agents would stay bold forever
  // after the user scrolled past it. Dismissal of done rows still requires
  // the explicit X; ack only changes the visual weight.
  const handleClick = useCallback(() => {
    setActiveWorktree(card.worktree.id)
    setActiveView('terminal')
    acknowledgeAgents(paneKeys)
  }, [card.worktree.id, paneKeys, setActiveWorktree, setActiveView, acknowledgeAgents])

  // Why: clicking an agent row navigates to that agent's tab AND acks the
  // row so it fades to the visited weight. Scoped to a single paneKey so
  // sibling rows (other agents on the same workspace) remain bold until the
  // user looks at them. Dismissal still requires the explicit X.
  const handleActivateAgent = useCallback(
    (tabId: string, paneKey: string) => {
      onActivateAgentTab(card.worktree.id, tabId)
      acknowledgeAgents([paneKey])
    },
    [card.worktree.id, onActivateAgentTab, acknowledgeAgents]
  )

  // Why: React's onFocus handler receives a SyntheticEvent, but the parent
  // needs the worktree id. Wrap here so the parent can pass a single stable
  // callback that does not get invalidated per-card per-render.
  const handleFocus = useCallback(() => {
    onFocus(card.worktree.id)
  }, [onFocus, card.worktree.id])

  const branchName = card.worktree.branch?.replace(/^refs\/heads\//, '') ?? ''

  // Why: workspace-level bold/muted weight tracks whether ANY of this card's
  // agents are unvisited — so the workspace header stays bold while even one
  // row inside it needs the user's attention, and fades once the user has
  // clicked through every agent. Per-agent granularity lives on the rows
  // themselves (DashboardAgentRow isUnvisited prop). If a workspace has no
  // agents (edge case during spin-up), default to muted so the row doesn't
  // read louder than it has value to.
  const anyAgentUnvisited = card.agents.some((a) =>
    isAgentUnvisited(a.paneKey, a.entry.stateStartedAt)
  )

  // Why: the card is a clickable *surface* but NOT a `role="button"` — its
  // children (DashboardAgentRow) render real <button>s (dismiss X, chevron),
  // and ARIA forbids interactive descendants inside a role=button ancestor
  // (screen readers flatten it, leaving the inner buttons unreachable). The
  // dashboard's keyboard hook (useDashboardKeyboard.ts) owns Enter/arrow-key
  // routing via `closest('[data-worktree-id]')`, so activation is handled
  // there — we only need the surface to be programmatically focusable
  // (tabIndex={-1}) so arrow-key navigation's `cardEl.focus()` works. This
  // mirrors the DashboardBottomPanel.tsx:247-253 pattern.
  return (
    <div
      tabIndex={-1}
      data-worktree-id={card.worktree.id}
      onClick={handleClick}
      onFocus={handleFocus}
      className={cn(
        'cursor-pointer px-2.5 py-1 transition-colors duration-100',
        // Why: light-mode hovers have to darken (not lighten) the surface —
        // `--accent` is #f5f5f5 so adding it to white lifts nothing. Use a
        // black alpha overlay in light mode and keep the original
        // alpha-on-accent for dark mode, mirroring WorktreeCard's active
        // state pattern. Focus/focused are each one step stronger than
        // hover, keeping the same hierarchy dark mode already reads.
        'hover:bg-black/[0.04] dark:hover:bg-accent/20',
        'focus-visible:outline-none focus-visible:bg-black/[0.06] dark:focus-visible:bg-accent/30',
        // Why: the persistent tint tracks the *active* worktree (the one the
        // user is viewing), not the last card that happened to receive focus.
        // Focus state sticks around after click and never clears, so using
        // it for the persistent highlight made every clicked row appear
        // selected forever; tying it to activeWorktreeId keeps the highlight
        // in sync with what the user actually has open.
        isActive && 'bg-black/[0.05] dark:bg-accent/25',
        !isLast && 'border-b border-border/80'
      )}
    >
      {/* Worktree header row. Why: workspace name + branch share one line
          to save vertical space — the branch is a secondary qualifier that
          reads fine as a muted suffix rather than its own line. Weight is
          driven by anyAgentUnvisited so unvisited workspaces read boldly,
          while already-visited ones fade into the background. */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span
          className={cn(
            'text-[11px] truncate leading-tight shrink-0 max-w-[60%]',
            anyAgentUnvisited
              ? 'font-semibold text-foreground'
              : 'font-normal text-muted-foreground'
          )}
        >
          {card.worktree.displayName}
        </span>
        {branchName && (
          <span className="text-[10px] text-muted-foreground/60 truncate min-w-0 leading-tight">
            {branchName}
          </span>
        )}
      </div>

      {/* Agent rows with activity blocks */}
      {card.agents.length > 0 && (
        <div className="mt-1.5 flex flex-col divide-y divide-border">
          {card.agents.map((agent, index) => (
            <div key={agent.paneKey} className={cn(index === 0 ? 'pb-1' : 'py-1')}>
              <DashboardAgentRow
                agent={agent}
                onDismiss={onDismissAgent}
                onActivate={handleActivateAgent}
                now={now}
                isUnvisited={isAgentUnvisited(agent.paneKey, agent.entry.stateStartedAt)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default DashboardWorktreeCard
