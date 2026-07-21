import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { AgentStateDot } from '@/components/AgentStateDot'
import { cn } from '@/lib/utils'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'

/** Compact "started N ago" (the card is glanceable — coarse units are fine). */
function formatStartedAgo(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) {
    return translate('dashboardPopout.card.time.justNow', 'just now')
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return translate('dashboardPopout.card.time.minutes', '{{count}}m', { count: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return translate('dashboardPopout.card.time.hours', '{{count}}h', { count: hours })
  }
  return translate('dashboardPopout.card.time.days', '{{count}}d', {
    count: Math.floor(hours / 24)
  })
}

function sameCard(a: DashboardCard, b: DashboardCard): boolean {
  return (
    a.paneKey === b.paneKey &&
    a.ptyId === b.ptyId &&
    a.agentType === b.agentType &&
    a.bucket === b.bucket &&
    a.dotState === b.dotState &&
    a.task === b.task &&
    a.lastUserMessage === b.lastUserMessage &&
    a.lastAgentMessage === b.lastAgentMessage &&
    a.repoId === b.repoId &&
    a.worktreeId === b.worktreeId &&
    a.tabId === b.tabId &&
    a.leafId === b.leafId &&
    a.repoName === b.repoName &&
    a.worktreeName === b.worktreeName &&
    a.startedAt === b.startedAt &&
    a.stateChangedAt === b.stateChangedAt &&
    a.unseen === b.unseen &&
    a.askSummary === b.askSummary
  )
}

type AgentKanbanCardProps = {
  card: DashboardCard
  now: number
  /** Opens the board-level terminal dialog. The dialog is NOT owned by the
   *  card: bucket moves remount the card, and an embedded dialog would close
   *  the chat mid-conversation. */
  onOpenTerminal: (card: DashboardCard) => void
}

/** One agent on the kanban board. Clicking opens the board's live terminal dialog. */
export const AgentKanbanCard = memo(
  function AgentKanbanCard({ card, now, onOpenTerminal }: AgentKanbanCardProps): React.JSX.Element {
    useTranslation()

    return (
      <button
        type="button"
        onClick={() => onOpenTerminal(card)}
        // Why: a stable per-agent view-transition-name lets the browser morph
        // the card from its old column to its new one when its bucket changes.
        // paneKey has ':'/'/' which aren't valid in a custom-ident, so slugify.
        style={{ viewTransitionName: `agentcard-${card.paneKey.replace(/[^a-zA-Z0-9]/g, '-')}` }}
        className={cn(
          'group flex w-full flex-col gap-1.5 rounded-lg border border-border/60 bg-card p-2.5 text-left',
          'transition-colors hover:border-border hover:bg-accent/40',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      >
        <div className="flex items-center gap-1.5">
          <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={14} />
          <span
            // Why: same unvisited treatment as the sidebar's DashboardAgentRow —
            // bold+bright until acked, normal+muted after — so both surfaces
            // read identically (the ack map is shared).
            className={cn(
              'truncate text-[12.5px]',
              card.unseen ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground'
            )}
          >
            {card.worktreeName}
          </span>
          <AgentStateDot state={card.dotState} className="ml-auto" />
        </div>

        {card.lastUserMessage || card.lastAgentMessage ? (
          <div className="flex flex-col gap-0.5">
            {card.lastUserMessage ? (
              <div className="line-clamp-1 text-[11px] leading-snug text-muted-foreground">
                <span className="font-medium text-foreground/45">
                  {translate('dashboardPopout.card.you', 'You')}
                </span>{' '}
                {card.lastUserMessage}
              </div>
            ) : null}
            {card.lastAgentMessage ? (
              <div className="line-clamp-2 text-xs leading-snug text-foreground/90">
                <span className="font-medium text-foreground/45">
                  {formatAgentTypeLabel(card.agentType)}
                </span>{' '}
                {card.lastAgentMessage}
              </div>
            ) : null}
          </div>
        ) : card.task ? (
          <div className="line-clamp-2 text-xs leading-snug text-foreground/90">{card.task}</div>
        ) : null}

        {card.askSummary ? (
          <div className="flex items-start gap-1 rounded-md bg-amber-500/10 px-1.5 py-1 text-[11px] text-amber-600 dark:text-amber-400">
            <span aria-hidden>✋</span>
            <span className="line-clamp-2">{card.askSummary}</span>
          </div>
        ) : null}

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate font-mono">{card.repoName}</span>
          {card.startedAt > 0 ? (
            <span className="ml-auto shrink-0 tabular-nums">
              {formatStartedAgo(card.startedAt, now)}
            </span>
          ) : null}
        </div>
      </button>
    )
  },
  (previous, next) =>
    previous.onOpenTerminal === next.onOpenTerminal &&
    sameCard(previous.card, next.card) &&
    (previous.card.startedAt <= 0 ||
      formatStartedAgo(previous.card.startedAt, previous.now) ===
        formatStartedAgo(next.card.startedAt, next.now))
)
