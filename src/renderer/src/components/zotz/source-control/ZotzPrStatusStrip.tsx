import React, { useState } from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  GitMerge,
  GitPullRequestCreate
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { resolveGitHubPRMergeMethods } from '../../../../../shared/github/pull-requests/merge/pull-request-merge-methods'
import { mergeGitHubHostedReview } from '../../right-sidebar/hosted-review/provider-actions/hosted-review-github-actions'
import { useZotzWorktreePr, type ZotzWorktreePr } from '../pr-status/use-zotz-worktree-pr'
import {
  ZOTZ_PR_TONE_TEXT,
  zotzLivePrStatus,
  zotzPrStatusLabel,
  zotzPrTone
} from '../pr-status/zotz-pr-status'
import { useZotzPrChecksMonitor } from './use-zotz-pr-checks'
import { ZotzPrStatusIcon } from '../pr-status/ZotzPrStatusIcon'
import { ZotzPrChecksList, ZotzPrChecksSummary } from './ZotzPrChecksList'
import { zotzReviewRef } from './ZotzPrChip'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { sendToZotzConversationAgent, ZOTZ_CREATE_PR_PROMPT } from './zotz-agent-send'

/**
 * Top of Source Control, Conductor-style: "Create PR" before there is one, then "PR #N · state",
 * green with Merge once it is ready.
 */
export function ZotzPrStatusStrip({
  worktreeId,
  onCreatePrFallback
}: {
  worktreeId: string
  /** Upstream's own create-PR flow, for a conversation with no agent to ask. */
  onCreatePrFallback: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const repo = useAppStore((s) => s.repos.find((r) => r.id === repoId))
  const worktree = useAppStore(
    (s) => selectWorktreesByRepo(s)[repoId]?.find((w) => w.id === worktreeId) ?? null
  )
  const found = useZotzWorktreePr(worktree, repo)
  const [busy, setBusy] = useState(false)
  if (!worktree || !repo || worktree.isMainWorktree) {
    return null
  }

  if (!found) {
    const createPr = async (): Promise<void> => {
      setBusy(true)
      const outcome = await sendToZotzConversationAgent(worktreeId, ZOTZ_CREATE_PR_PROMPT)
      setBusy(false)
      if (outcome === 'no-agent') {
        onCreatePrFallback()
      } else if (outcome === 'sent') {
        toast.success(t('zotz.pr.createSent', 'Asked the agent to open the pull request'))
      } else {
        toast.error(t('zotz.pr.createFailed', 'Could not ask the agent to open the pull request'))
      }
    }
    return (
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t('zotz.pr.none', 'No pull request yet')}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void createPr()}
        >
          {busy ? (
            <LoadingSpinner className="size-3" />
          ) : (
            <GitPullRequestCreate className="size-3" />
          )}
          {t('zotz.pr.create', 'Create PR')}
        </Button>
      </div>
    )
  }

  return <StripWithPr worktreeId={worktreeId} repo={repo} found={found} />
}

/** The strip once there is a PR: live check counts, the checks list on demand, and Merge. */
function StripWithPr({
  worktreeId,
  repo,
  found
}: {
  worktreeId: string
  repo: Repo
  found: ZotzWorktreePr
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const monitor = useZotzPrChecksMonitor(worktreeId, zotzReviewRef(found))
  const { pr, githubPR } = found
  const { counts } = monitor
  const status = zotzLivePrStatus(found.status, {
    loaded: monitor.checks !== null,
    failed: counts.failed,
    running: counts.running,
    total: monitor.sorted.length
  })
  // Opens on its own when something fails; the user can still fold it.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const open = openOverride ?? counts.failed > 0
  const tone = zotzPrTone(status)
  const canMerge = status === 'ready' && pr.provider === 'github'
  const merge = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await mergeGitHubHostedReview({
        repo,
        prNumber: pr.number,
        method: resolveGitHubPRMergeMethods(githubPR?.mergeMethodSettings).defaultMethod,
        prRepo: githubPR?.prRepo ?? null
      })
      if (result.ok) {
        toast.success(
          t('zotz.pr.mergedToast', 'Pull request #{{number}} merged', { number: pr.number })
        )
      } else {
        toast.error(t('zotz.pr.mergeFailed', 'Could not merge the pull request'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={cn(
        'shrink-0 border-b px-3 py-1.5',
        tone === 'success' ? 'border-zotz-gh-success/30 bg-zotz-gh-success/10' : 'border-border'
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!pr.url}
          onClick={() => pr.url && openAppHttpLink(pr.url, { destination: 'system' })}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs font-medium hover:bg-accent"
        >
          PR #{pr.number}
          <ArrowUpRight className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => setOpenOverride(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ZotzPrStatusIcon status={status} />
          <span className={cn('min-w-0 truncate font-medium', ZOTZ_PR_TONE_TEXT[tone])}>
            {zotzPrStatusLabel(status, t)}
          </span>
          <span className="ml-auto shrink-0">
            <ZotzPrChecksSummary monitor={monitor} />
          </span>
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        {canMerge ? (
          <Button type="button" size="xs" disabled={busy} onClick={() => void merge()}>
            {busy ? <LoadingSpinner className="size-3" /> : <GitMerge className="size-3" />}
            {t('zotz.pr.merge', 'Merge')}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2">
          <ZotzPrChecksList worktreeId={worktreeId} monitor={monitor} showSummary={false} />
        </div>
      ) : null}
    </div>
  )
}
