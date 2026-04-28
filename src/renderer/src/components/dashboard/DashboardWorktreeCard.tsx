import React, { useCallback } from 'react'
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

  // Why: clicking a worktree row only navigates. It does NOT dismiss retained
  // done agents — the user may have multiple agents done (e.g. Claude + Codex)
  // and silently dropping any of them on row click erases a signal they were
  // about to click through to investigate. Dismissal happens only through the
  // explicit X button on each agent row.
  const handleClick = useCallback(() => {
    setActiveWorktree(card.worktree.id)
    setActiveView('terminal')
  }, [card.worktree.id, setActiveWorktree, setActiveView])

  // Why: clicking an agent row only navigates to that agent's tab. It must not
  // call onCheck() — that would mark the worktree as checked AND dismiss all
  // retained done rows in it, which erases the signal the user was clicking
  // through to investigate. Only the X button on a done row should dismiss it.
  const handleActivateAgent = useCallback(
    (tabId: string) => {
      onActivateAgentTab(card.worktree.id, tabId)
    },
    [card.worktree.id, onActivateAgentTab]
  )

  // Why: React's onFocus handler receives a SyntheticEvent, but the parent
  // needs the worktree id. Wrap here so the parent can pass a single stable
  // callback that does not get invalidated per-card per-render.
  const handleFocus = useCallback(() => {
    onFocus(card.worktree.id)
  }, [onFocus, card.worktree.id])

  const branchName = card.worktree.branch?.replace(/^refs\/heads\//, '') ?? ''

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
          reads fine as a muted suffix rather than its own line. */}
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-[11px] font-semibold text-foreground truncate leading-tight shrink-0 max-w-[60%]">
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
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default DashboardWorktreeCard
