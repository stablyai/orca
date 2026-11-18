import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  Wrench
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { isBrokenCheck } from '../../../../../shared/source-control/checks/pr-checks-fix-prompt'
import { fixZotzPrChecks, type ZotzFixChecksOutcome } from './zotz-pr-fix-checks'
import { markZotzPrAutofixSent, setZotzPrAutofix, useZotzPrAutofix } from './zotz-pr-autofix-store'

const POLL_RUNNING_MS = 30_000
const POLL_SETTLED_MS = 120_000
const LIST_LIMIT = 8

type CheckKind = 'failed' | 'running' | 'passed' | 'skipped'

function checkKind(check: PRCheckDetail): CheckKind {
  if (isBrokenCheck(check)) {
    return 'failed'
  }
  if (check.status !== 'completed') {
    return 'running'
  }
  return check.conclusion === 'skipped' || check.conclusion === 'neutral' ? 'skipped' : 'passed'
}

const KIND_ORDER: Record<CheckKind, number> = { failed: 0, running: 1, passed: 2, skipped: 3 }

function CheckIcon({ kind }: { kind: CheckKind }): React.JSX.Element {
  switch (kind) {
    case 'failed':
      return <CircleX className="size-3.5 shrink-0 text-destructive" />
    case 'running':
      return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
    case 'passed':
      return <CircleCheck className="size-3.5 shrink-0 text-status-success" />
    case 'skipped':
      return <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />
  }
}

/** Polls the PR's checks: every 30 s while some run, every 2 min once all settled. */
function usePrChecks(worktreeId: string, review: HostedReviewInfo): PRCheckDetail[] | null {
  const repo = useAppStore((s) => s.repos.find((r) => r.id === getRepoIdFromWorktreeId(worktreeId)))
  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const [checks, setChecks] = useState<PRCheckDetail[] | null>(null)
  const head = review.headSha ?? null
  useEffect(() => {
    if (!repo) {
      return
    }
    let alive = true
    let running = true
    let lastLoadAt = 0
    const prRepo = review.githubRepository
      ? { owner: review.githubRepository.owner, repo: review.githubRepository.repo }
      : null
    const load = async (): Promise<void> => {
      lastLoadAt = Date.now()
      const result = await fetchPRChecks(
        repo.path,
        review.number,
        undefined,
        head ?? undefined,
        prRepo,
        {
          repoId: repo.id,
          repoOwnerExecutionHostId: getRepoExecutionHostId(repo),
          background: true
        }
      ).catch(() => null)
      if (!alive) {
        return
      }
      if (result) {
        setChecks(result)
      }
      running = (result ?? []).some((check) => check.status !== 'completed')
    }
    void load()
    // One fixed tick; settled checks just skip ticks until their slower cadence is due.
    const timer = setInterval(() => {
      if (running || Date.now() - lastLoadAt >= POLL_SETTLED_MS) {
        void load()
      }
    }, POLL_RUNNING_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [repo, fetchPRChecks, review.number, review.githubRepository, head])
  return checks
}

/**
 * Source Control's first section: this conversation's PR and its CI checks, with "Fix errors"
 * (sent to the conversation's own agent) and the session's autofix switch.
 */
export function ZotzPrChecksSection({
  worktreeId,
  review
}: {
  worktreeId: string
  review: HostedReviewInfo
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(true)
  const [fixing, setFixing] = useState(false)
  const repo = useAppStore((s) => s.repos.find((r) => r.id === getRepoIdFromWorktreeId(worktreeId)))
  const checks = usePrChecks(worktreeId, review)
  const autofix = useZotzPrAutofix(worktreeId)

  const sorted = useMemo(
    () =>
      (checks ?? [])
        .map((check) => ({ check, kind: checkKind(check) }))
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]),
    [checks]
  )
  const counts = useMemo(() => {
    const result: Record<CheckKind, number> = { failed: 0, running: 0, passed: 0, skipped: 0 }
    for (const { kind } of sorted) {
      result[kind] += 1
    }
    return result
  }, [sorted])
  const head = review.headSha ?? `pr-${review.number}`
  // A head only counts as failed once nothing still runs: partial failures can still be retried.
  const settledWithFailures = counts.failed > 0 && counts.running === 0

  const reportOutcome = useCallback(
    (outcome: ZotzFixChecksOutcome) => {
      if (outcome === 'sent') {
        toast.success(t('zotz.prChecks.sent', 'Sent the failing checks to the conversation'))
      } else if (outcome === 'launched') {
        toast.success(t('zotz.prChecks.launched', 'No agent here: opened one to fix the checks'))
      } else if (outcome === 'failed') {
        toast.error(t('zotz.prChecks.sendFailed', 'Could not send the failing checks'))
      }
    },
    [t]
  )

  const runFix = useCallback(
    async (onlyIfIdle: boolean): Promise<ZotzFixChecksOutcome | null> => {
      if (!repo || !checks || fixing) {
        return null
      }
      setFixing(true)
      try {
        return await fixZotzPrChecks({ worktreeId, repo, review, checks, onlyIfIdle })
      } finally {
        setFixing(false)
      }
    },
    [repo, checks, fixing, worktreeId, review]
  )

  // Autofix: once per pushed head, when every check settled and some failed.
  const autofixInFlight = useRef(false)
  useEffect(() => {
    if (
      !autofix.enabled ||
      !settledWithFailures ||
      autofix.lastSentHead === head ||
      autofixInFlight.current
    ) {
      return
    }
    autofixInFlight.current = true
    void runFix(true).then((outcome) => {
      autofixInFlight.current = false
      if (outcome === 'sent') {
        markZotzPrAutofixSent(worktreeId, head)
        reportOutcome(outcome)
      }
    })
  }, [
    autofix.enabled,
    autofix.lastSentHead,
    settledWithFailures,
    head,
    runFix,
    worktreeId,
    reportOutcome
  ])

  const visible = sorted.slice(0, LIST_LIMIT)
  return (
    <section
      className="border-b border-border px-3 py-2"
      aria-label={t('zotz.prChecks.title', 'Pull request')}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 text-xs font-semibold text-muted-foreground">
            #{review.number}
          </span>
          <span className="min-w-0 truncate text-sm font-medium">{review.title}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('zotz.prChecks.openPr', 'Open the pull request')}
          onClick={() => openAppHttpLink(review.url, { destination: 'system' })}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-xs text-muted-foreground">
        {checks === null ? (
          <span className="flex items-center gap-1.5">
            <LoadingSpinner className="size-3" />
            {t('zotz.prChecks.loading', 'Loading checks…')}
          </span>
        ) : checks.length === 0 ? (
          <span>{t('zotz.prChecks.none', 'No checks on this pull request')}</span>
        ) : (
          <>
            {counts.failed > 0 ? (
              <span className="font-medium text-destructive">
                {t('zotz.prChecks.failed', '{{count}} failed', { count: counts.failed })}
              </span>
            ) : null}
            {counts.running > 0 ? (
              <span>
                {t('zotz.prChecks.running', '{{count}} running', { count: counts.running })}
              </span>
            ) : null}
            <span>{t('zotz.prChecks.passed', '{{count}} passed', { count: counts.passed })}</span>
          </>
        )}
      </div>

      {open && visible.length > 0 ? (
        <ul className="mt-2 space-y-0.5 pl-5">
          {visible.map(({ check, kind }) => (
            <li key={`${check.name}-${check.checkRunId ?? check.url ?? ''}`}>
              <button
                type="button"
                disabled={!check.url}
                onClick={() => check.url && openAppHttpLink(check.url, { destination: 'system' })}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs',
                  check.url ? 'hover:bg-accent' : 'cursor-default'
                )}
              >
                <CheckIcon kind={kind} />
                <span className={cn('min-w-0 truncate', kind === 'failed' && 'text-foreground')}>
                  {check.name}
                </span>
              </button>
            </li>
          ))}
          {sorted.length > visible.length ? (
            <li className="px-1 text-xs text-muted-foreground">
              {t('zotz.prChecks.more', '+{{count}} more', {
                count: sorted.length - visible.length
              })}
            </li>
          ) : null}
        </ul>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-5">
        <button
          type="button"
          role="switch"
          aria-checked={autofix.enabled}
          onClick={() => setZotzPrAutofix(worktreeId, !autofix.enabled)}
          className="group flex items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <SwitchIndicator checked={autofix.enabled} size="compact" />
          <span className="text-muted-foreground transition-colors group-hover:text-foreground">
            {t('zotz.prChecks.autofix', 'Autofix')}
          </span>
        </button>
        {counts.failed > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={fixing || !repo}
            onClick={() => void runFix(false).then((outcome) => outcome && reportOutcome(outcome))}
          >
            {fixing ? <LoadingSpinner className="size-3" /> : <Wrench className="size-3" />}
            {t('zotz.prChecks.fix', 'Fix errors')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
