import React, { useState } from 'react'
import { ChevronDown, GitPullRequest, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { Worktree } from '../../../../../shared/worktree/types'
import { useZotzWorktreePr, type ZotzWorktreePr } from '../pr-status/use-zotz-worktree-pr'
import {
  ZOTZ_PR_TONE_TEXT,
  zotzLivePrStatus,
  zotzPrStatusLabel,
  zotzPrTone
} from '../pr-status/zotz-pr-status'
import { useZotzPrChecksMonitor } from './use-zotz-pr-checks'
import { ZotzPrChecksList } from './ZotzPrChecksList'
import type { ZotzReviewRef } from './zotz-pr-fix-checks'

// Closed for this run only: a new PR or a restart brings the chip back.
const dismissed = new Set<string>()

/** What the fix prompt and check reads need, from either the card display or the GitHub read. */
export function zotzReviewRef(found: ZotzWorktreePr): ZotzReviewRef {
  const { pr, githubPR } = found
  const hosted = 'mergeable' in pr ? pr : null
  return {
    provider: pr.provider,
    number: pr.number,
    title: pr.title,
    url: pr.url ?? '',
    headSha: hosted?.headSha ?? githubPR?.headSha,
    githubRepository: hosted?.githubRepository ?? githubPR?.prRepo ?? undefined
  }
}

function CiDot({ failed, running }: { failed: number; running: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 rounded-full',
        failed > 0 ? 'bg-destructive' : running > 0 ? 'bg-muted-foreground' : 'bg-status-success'
      )}
    />
  )
}

function ChipBody({
  worktree,
  found,
  repoName,
  onDismiss
}: {
  worktree: Worktree
  found: ZotzWorktreePr
  repoName: string
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const review = zotzReviewRef(found)
  const monitor = useZotzPrChecksMonitor(worktree.id, review)
  const total = useAppStore((s) => s.gitBranchLineTotalByWorktree?.[worktree.id] ?? null)
  const status = zotzLivePrStatus(found.status, {
    loaded: monitor.checks !== null,
    failed: monitor.counts.failed,
    running: monitor.counts.running,
    total: monitor.sorted.length
  })
  const tone = zotzPrTone(status)
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-3 py-1.5 text-xs"
      data-zotz-pr-chip=""
    >
      <button
        type="button"
        onClick={() => review.url && openAppHttpLink(review.url, { destination: 'system' })}
        className="flex items-center gap-1.5 rounded-md font-medium text-foreground hover:underline"
        aria-label={t('zotz.prChecks.openPr', 'Open the pull request')}
      >
        <GitPullRequest className="size-3.5" />#{review.number}
      </button>
      <span className="text-muted-foreground">{repoName}</span>
      <span className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono">{branch}</span>
      <span className={cn('shrink-0 font-medium', ZOTZ_PR_TONE_TEXT[tone])}>
        {zotzPrStatusLabel(status, t)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {total && (total.added > 0 || total.removed > 0) ? (
          <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono tabular-nums">
            <span className="text-status-success">+{total.added}</span>{' '}
            <span className="text-destructive">−{total.removed}</span>
          </span>
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="xs">
              <CiDot failed={monitor.counts.failed} running={monitor.counts.running} />
              CI
              <ChevronDown className="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-80">
            <ZotzPrChecksList worktreeId={worktree.id} monitor={monitor} />
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('zotz.prChip.dismiss', 'Hide the pull request bar')}
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      </span>
    </div>
  )
}

/** Conductor/Claude-style PR bar under the active conversation; it also keeps its autofix running. */
export function ZotzPrChip(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repoId = activeWorktreeId ? getRepoIdFromWorktreeId(activeWorktreeId) : null
  const repo = useAppStore((s) => (repoId ? s.repos.find((r) => r.id === repoId) : undefined))
  const worktree = useAppStore((s) =>
    repoId && activeWorktreeId
      ? (selectWorktreesByRepo(s)[repoId]?.find((w) => w.id === activeWorktreeId) ?? null)
      : null
  )
  const found = useZotzWorktreePr(worktree, repo)
  const [, rerender] = useState(0)
  if (!worktree || !found || !repo) {
    return null
  }
  const key = `${worktree.id}#${found.pr.number}`
  if (dismissed.has(key)) {
    return null
  }
  return (
    <ChipBody
      key={key}
      worktree={worktree}
      found={found}
      repoName={repo.displayName}
      onDismiss={() => {
        dismissed.add(key)
        rerender((value) => value + 1)
      }}
    />
  )
}
