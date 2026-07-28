import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircleQuestion } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { AgentStateDot } from '@/components/AgentStateDot'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
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

/** The timestamp the card's time column counts from: since it finished when the
 *  agent has completed, else since it started — parity with the worktree sidebar. */
function displayTimestamp(card: DashboardCard): number {
  return card.finishedAt ?? card.startedAt
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
    a.finishedAt === b.finishedAt &&
    a.stateChangedAt === b.stateChangedAt &&
    a.unseen === b.unseen &&
    a.askSummary === b.askSummary &&
    a.conversationName === b.conversationName
  )
}

/** Structural — the icon arrives inside a fresh structured clone each publish,
 *  so identity alone would re-render every card several times a second. */
function sameRepoIcon(a: RepoIcon | null | undefined, b: RepoIcon | null | undefined): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.type !== b.type) {
    return false
  }
  if (a.type === 'lucide') {
    return a.name === (b as typeof a).name
  }
  if (a.type === 'emoji') {
    return a.emoji === (b as typeof a).emoji
  }
  const image = b as typeof a
  return a.src === image.src && a.source === image.source && a.label === image.label
}

type AgentKanbanCardProps = {
  card: DashboardCard
  /** The card repo's icon. null renders the default folder glyph. */
  repoIcon?: RepoIcon | null
  now: number
  /** Opens the board-level terminal dialog. The dialog is NOT owned by the
   *  card: bucket moves remount the card, and an embedded dialog would close
   *  the chat mid-conversation. */
  onOpenTerminal: (card: DashboardCard) => void
}

/** One agent on the kanban board. Clicking opens the board's live terminal dialog. */
export const AgentKanbanCard = memo(
  function AgentKanbanCard({
    card,
    repoIcon = null,
    now,
    onOpenTerminal
  }: AgentKanbanCardProps): React.JSX.Element {
    useTranslation()
    // Why: the two outcomes worth scanning for get a tinted card — amber for
    // "answer me", green for "finished, look at it". Everything else stays
    // neutral so the tint keeps meaning something.
    const needsYou = card.bucket === 'attention'
    const isDone = card.dotState === 'done'
    // Why: the session's own name heads the card. Without one the worktree is
    // the best heading left — and then the footer drops it rather than say it
    // twice.
    const heading = card.conversationName ?? card.worktreeName
    const worktreeInFooter = card.conversationName !== undefined

    return (
      <button
        type="button"
        onClick={() => onOpenTerminal(card)}
        // Why: a stable per-agent view-transition-name lets the browser morph
        // the card from its old column to its new one when its bucket changes.
        // paneKey has ':'/'/' which aren't valid in a custom-ident, so slugify.
        style={{ viewTransitionName: `agentcard-${card.paneKey.replace(/[^a-zA-Z0-9]/g, '-')}` }}
        className={cn(
          'group flex w-full flex-col gap-1.5 rounded-lg border p-2.5 text-left',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          needsYou
            ? 'border-amber-500/40 bg-amber-500/[0.06] hover:border-amber-500/60 hover:bg-amber-500/10'
            : isDone
              ? 'border-emerald-500/40 bg-emerald-500/[0.06] hover:border-emerald-500/60 hover:bg-emerald-500/10'
              : 'border-border/60 bg-card hover:border-border hover:bg-accent/40'
        )}
      >
        <div className="flex items-center gap-1.5">
          {/* Why: a bare <svg> flex item shrinks with the row — long worktree names squashed the icon. */}
          <span className="inline-flex shrink-0">
            <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={14} />
          </span>
          <span
            // Why: same unvisited treatment as the sidebar's DashboardAgentRow —
            // bold+bright until acked, normal+muted after — so both surfaces
            // read identically (the ack map is shared).
            className={cn(
              'truncate text-[12.5px]',
              card.unseen ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground'
            )}
          >
            {heading}
          </span>
          {/* The summary pill already carries the attention glyph. */}
          {card.askSummary ? null : <AgentStateDot state={card.dotState} className="ml-auto" />}
        </div>

        {card.lastUserMessage || card.lastAgentMessage ? (
          <div className="flex flex-col gap-0.5">
            {card.lastUserMessage ? (
              <div className="line-clamp-1 text-[11px] leading-snug text-muted-foreground">
                {/* Why: plain "You" again — the session's name now heads the card. */}
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

        {/* Why: the card behind it is amber now, so the pill needs its own edge
            to stay a distinct chip instead of a flat block of tint. */}
        {card.askSummary ? (
          <div className="flex items-start gap-1 rounded-md bg-amber-500/15 px-1.5 py-1 text-[11px] text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
            <MessageCircleQuestion className="mt-px size-3 shrink-0" aria-hidden />
            <span className="line-clamp-2">{card.askSummary}</span>
          </div>
        ) : null}

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {/* Why: the project reads as an icon so its name can't crowd the
              worktree sitting next to it; the name lives in the tooltip. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-muted-foreground/10 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-label={card.repoName}
              >
                <RepoIconGlyph repoIcon={repoIcon} className="size-3" iconClassName="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {card.repoName}
            </TooltipContent>
          </Tooltip>
          {worktreeInFooter ? <span className="truncate">{card.worktreeName}</span> : null}
          {displayTimestamp(card) > 0 ? (
            <span className="ml-auto shrink-0 pl-1 tabular-nums">
              {formatStartedAgo(displayTimestamp(card), now)}
            </span>
          ) : null}
        </div>
      </button>
    )
  },
  (previous, next) =>
    previous.onOpenTerminal === next.onOpenTerminal &&
    sameCard(previous.card, next.card) &&
    sameRepoIcon(previous.repoIcon, next.repoIcon) &&
    (displayTimestamp(previous.card) <= 0 ||
      formatStartedAgo(displayTimestamp(previous.card), previous.now) ===
        formatStartedAgo(displayTimestamp(next.card), next.now))
)
