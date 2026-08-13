import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageCircleQuestion
} from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { AgentStateDot } from '@/components/AgentStateDot'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  dashboardCardDisplayState,
  type DashboardCard
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { translate } from '@/i18n/i18n'
import { DashboardHostBadge } from './DashboardHostBadge'

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

function formatSubagentCount(count: number): string {
  return count === 1
    ? translate('dashboardPopout.card.subagents_one', '{{count}} subagent', { count })
    : translate('dashboardPopout.card.subagents_other', '{{count}} subagents', { count })
}

function sameSubagents(a: DashboardCard['subagents'], b: DashboardCard['subagents']): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!(index in a) || !(index in b)) {
      if (index in a !== index in b) {
        return false
      }
      continue
    }
    const subagent = a[index]
    const other = b[index]
    if (
      subagent.id !== other.id ||
      subagent.name !== other.name ||
      subagent.dotState !== other.dotState
    ) {
      return false
    }
  }
  return true
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
    a.hostKind === b.hostKind &&
    a.executionHostId === b.executionHostId &&
    a.hostLabel === b.hostLabel &&
    a.hasReview === b.hasReview &&
    a.review?.number === b.review?.number &&
    a.review?.state === b.review?.state &&
    sameSubagents(a.subagents, b.subagents) &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.stateChangedAt === b.stateChangedAt &&
    a.unseen === b.unseen &&
    a.askSummary === b.askSummary &&
    a.conversationName === b.conversationName
  )
}

const REVIEW_PRESENTATION = {
  open: {
    icon: GitPullRequest,
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  },
  draft: {
    icon: GitPullRequestDraft,
    className: 'border-border bg-muted/60 text-muted-foreground'
  },
  merged: {
    icon: GitMerge,
    className: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
  },
  closed: {
    icon: GitPullRequestClosed,
    className: 'border-destructive/30 bg-destructive/10 text-destructive'
  }
} as const

function ReviewPill({ card }: { card: DashboardCard }): React.JSX.Element | null {
  if (!card.review) {
    return null
  }
  const presentation = REVIEW_PRESENTATION[card.review.state]
  const Icon = presentation.icon
  const title = (() => {
    switch (card.review.state) {
      case 'open':
        return translate('dashboardPopout.card.review.open', 'Open review')
      case 'draft':
        return translate('dashboardPopout.card.review.draft', 'Draft review')
      case 'merged':
        return translate('dashboardPopout.card.review.merged', 'Merged review')
      case 'closed':
        return translate('dashboardPopout.card.review.closed', 'Closed review')
    }
  })()
  return (
    <span
      role="img"
      aria-label={`${title} #${card.review.number}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1 py-px text-[10px] leading-none tabular-nums',
        presentation.className
      )}
    >
      <Icon className="size-2.5" aria-hidden />#{card.review.number}
    </span>
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
    const [subagentsOpen, setSubagentsOpen] = useState(false)
    // Why: the two outcomes worth scanning for get a tinted card — amber for
    // "answer me", green for "finished, look at it". Everything else stays
    // neutral so the tint keeps meaning something.
    const needsYou = card.bucket === 'attention'
    const displayState = dashboardCardDisplayState(card)
    const isDone = displayState === 'done'
    // Why: the session's own name heads the card. Without one the worktree is
    // the best heading left — and then the footer drops it rather than say it
    // twice.
    const heading = card.conversationName ?? card.worktreeName
    const worktreeInFooter = card.conversationName !== undefined

    return (
      <div
        // Why: a stable per-agent view-transition-name lets the browser morph
        // the card from its old column to its new one when its bucket changes.
        // paneKey has ':'/'/' which aren't valid in a custom-ident, so slugify.
        style={{ viewTransitionName: `agentcard-${card.paneKey.replace(/[^a-zA-Z0-9]/g, '-')}` }}
        className={cn(
          'group flex w-full flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors',
          needsYou
            ? 'border-amber-500/40 bg-amber-500/[0.06] hover:border-amber-500/60 hover:bg-amber-500/10'
            : isDone
              ? 'border-emerald-500/40 bg-emerald-500/[0.06] hover:border-emerald-500/60 hover:bg-emerald-500/10'
              : 'border-border/60 bg-card hover:border-border hover:bg-accent/40'
        )}
      >
        <button
          type="button"
          onClick={() => onOpenTerminal(card)}
          className="flex w-full flex-col gap-1.5 text-left focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <div className="flex w-full items-center gap-1.5">
            {/* Why: a bare <svg> flex item shrinks with the row. */}
            <span className="inline-flex shrink-0">
              <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={14} />
            </span>
            <span
              className={cn(
                'truncate text-[12.5px]',
                card.unseen ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground'
              )}
            >
              {heading}
            </span>
            {card.askSummary ? null : <AgentStateDot state={displayState} className="ml-auto" />}
          </div>

          {card.lastUserMessage || card.lastAgentMessage ? (
            <div className="flex w-full flex-col gap-0.5">
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
            <div className="line-clamp-2 w-full text-xs leading-snug text-foreground/90">
              {card.task}
            </div>
          ) : null}

          {card.askSummary ? (
            <div className="flex w-full items-start gap-1 rounded-md bg-amber-500/15 px-1.5 py-1 text-[11px] text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
              <MessageCircleQuestion className="mt-px size-3 shrink-0" aria-hidden />
              <span className="line-clamp-2">{card.askSummary}</span>
            </div>
          ) : null}
        </button>

        {card.subagents?.length ? (
          <>
            <button
              type="button"
              aria-expanded={subagentsOpen}
              onClick={() => setSubagentsOpen((open) => !open)}
              className="flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', subagentsOpen && 'rotate-90')}
              />
              {formatSubagentCount(card.subagents.length)}
            </button>
            {subagentsOpen ? (
              <div className="ml-1 flex flex-col gap-1 border-l border-border pl-2">
                {card.subagents.map((subagent) => (
                  <div
                    key={subagent.id}
                    className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    <AgentStateDot state={subagent.dotState} />
                    <span className="truncate">{subagent.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        <button
          type="button"
          onClick={() => onOpenTerminal(card)}
          className="flex w-full items-center gap-2 rounded-md text-left text-[11px] text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
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
          <DashboardHostBadge
            hostKind={card.hostKind}
            executionHostId={card.executionHostId}
            hostLabel={card.hostLabel}
            className="size-[18px] rounded-[5px] bg-muted-foreground/10 transition-colors group-hover:text-foreground"
          />
          {worktreeInFooter ? <span className="truncate">{card.worktreeName}</span> : null}
          <ReviewPill card={card} />
          {displayTimestamp(card) > 0 ? (
            <span className="ml-auto shrink-0 pl-1 tabular-nums">
              {formatStartedAgo(displayTimestamp(card), now)}
            </span>
          ) : null}
        </button>
      </div>
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
