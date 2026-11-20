import React from 'react'
import { Ban, GitPullRequest, Hourglass } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { AgentStateDot } from '@/components/AgentStateDot'
import { formatRelativeTime } from '@/components/activity/activity-thread-presentation'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type {
  ZotzConversationRow as Row,
  ZotzConversationStatus
} from './zotz-project-conversations'
import { ZotzWorkingRipple } from './ZotzWorkingRipple'
import { ZotzBackgroundSonar } from './ZotzBackgroundSonar'
import { useZotzWorktreePr } from '../pr-status/use-zotz-worktree-pr'
import { ZOTZ_PR_TONE_TEXT, zotzPrStatusLabel, zotzPrTone } from '../pr-status/zotz-pr-status'
import { ZotzPrStatusIcon } from '../pr-status/ZotzPrStatusIcon'
import { minutesSince } from '../agent-queue/zotz-memory-format'

function StatusMark({
  status,
  canceled,
  queued
}: {
  status: ZotzConversationStatus | null
  canceled: boolean
  queued: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (queued) {
    return (
      <Hourglass
        role="img"
        aria-label={t('zotz.agentQueue.queuedMark', 'Queued')}
        className="size-3 text-zotz-gh-pending"
      />
    )
  }
  if (status?.state === 'working') {
    return <ZotzWorkingRipple />
  }
  if (status?.state === 'monitoring') {
    return <ZotzBackgroundSonar />
  }
  if (status) {
    return (
      <AgentStateDot state={status.state} unread={status.unread} size="md" tooltipSide="right" />
    )
  }
  if (canceled) {
    return (
      <Ban
        role="img"
        aria-label={t('zotz.agentQueue.canceledMark', 'Canceled')}
        className="size-3 text-muted-foreground"
      />
    )
  }
  return <span aria-hidden className="size-1.5 rounded-full bg-worktree-sidebar-foreground/25" />
}

/** `+371 −28` against the branch base, once Source Control has measured it. */
function LineTotalBadge({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const total = useAppStore((s) => s.gitBranchLineTotalByWorktree?.[worktreeId] ?? null)
  if (!total || (total.added === 0 && total.removed === 0)) {
    return null
  }
  return (
    <span className="shrink-0 rounded-sm border border-worktree-sidebar-border px-1 font-mono text-2xs tabular-nums group-hover/conversation:invisible">
      <span className="text-zotz-gh-success">+{total.added}</span>
      {total.removed > 0 ? (
        <span className="ml-1 text-zotz-gh-danger">−{total.removed}</span>
      ) : null}
    </span>
  )
}

/** Conductor-style row: title and line totals, then branch · PR #N · its state (or how long ago). */
export function ZotzConversationRow({
  row,
  repo,
  active,
  status,
  canceled,
  queuedSince
}: {
  row: Row
  repo: Repo | undefined
  active: boolean
  status: ZotzConversationStatus | null
  /** Its only agent was canceled in the memory queue and never started. */
  canceled: boolean
  /** When its oldest agent entered the memory queue; null when none waits. */
  queuedSince: number | null
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(30_000, queuedSince !== null)
  const pr = useZotzWorktreePr(row.worktree, repo)
  const prTone = pr ? zotzPrTone(pr.status) : null
  const lastActivity = row.worktree?.lastActivityAt ?? 0
  return (
    <button
      type="button"
      data-current={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => activateAndRevealWorkspace(row.id)}
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-md py-1.5 pr-2 pl-6 text-left transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/80 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <span className="mt-1 flex h-3 w-5 shrink-0 items-center justify-center">
        <StatusMark status={status} canceled={canceled} queued={queuedSince !== null} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.title}</span>
          {row.worktree ? <LineTotalBadge worktreeId={row.worktree.id} /> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-2xs text-worktree-sidebar-foreground/50">
          {row.branch && row.branch !== row.title ? (
            <span className="min-w-0 truncate font-mono">{row.branch}</span>
          ) : null}
          {queuedSince !== null ? (
            <>
              {row.branch && row.branch !== row.title ? <span aria-hidden>·</span> : null}
              <span className="shrink-0 font-medium text-zotz-gh-pending">
                {t('zotz.agentQueue.queuedFor', 'Queued · {{minutes}} min', {
                  minutes: minutesSince(queuedSince, now)
                })}
              </span>
            </>
          ) : pr && prTone ? (
            <>
              {row.branch && row.branch !== row.title ? <span aria-hidden>·</span> : null}
              <GitPullRequest className="size-3 shrink-0" />
              <span className="shrink-0">#{pr.pr.number}</span>
              <span aria-hidden>·</span>
              <ZotzPrStatusIcon status={pr.status} className="size-3" />
              <span className={cn('shrink-0 font-medium', ZOTZ_PR_TONE_TEXT[prTone])}>
                {zotzPrStatusLabel(pr.status, t)}
              </span>
            </>
          ) : lastActivity > 0 ? (
            <>
              {row.branch && row.branch !== row.title ? <span aria-hidden>·</span> : null}
              <span className="shrink-0">{formatRelativeTime(lastActivity)}</span>
            </>
          ) : null}
        </span>
      </span>
    </button>
  )
}
