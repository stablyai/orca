import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useAppStore } from '@/store/index'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'
import { isBrokenCheck } from '../../../../../shared/source-control/checks/pr-checks-fix-prompt'
import {
  fixZotzPrChecks,
  type ZotzFixChecksOutcome,
  type ZotzReviewRef
} from './zotz-pr-fix-checks'
import { markZotzPrAutofixSent, useZotzPrAutofix } from './zotz-pr-autofix-store'

const POLL_RUNNING_MS = 30_000
const POLL_SETTLED_MS = 120_000

export type ZotzCheckKind = 'failed' | 'running' | 'passed' | 'skipped'

export function zotzCheckKind(check: PRCheckDetail): ZotzCheckKind {
  if (isBrokenCheck(check)) {
    return 'failed'
  }
  if (check.status !== 'completed') {
    return 'running'
  }
  return check.conclusion === 'skipped' || check.conclusion === 'neutral' ? 'skipped' : 'passed'
}

const KIND_ORDER: Record<ZotzCheckKind, number> = { failed: 0, running: 1, passed: 2, skipped: 3 }

export type ZotzPrChecksMonitor = {
  checks: PRCheckDetail[] | null
  sorted: { check: PRCheckDetail; kind: ZotzCheckKind }[]
  counts: Record<ZotzCheckKind, number>
  fixing: boolean
  autofixEnabled: boolean
  fix: () => void
}

/** Polls the PR's checks: every 30 s while some run, every 2 min once settled; paused while hidden. */
function usePolledChecks(worktreeId: string, review: ZotzReviewRef): PRCheckDetail[] | null {
  const repo = useAppStore((s) => s.repos.find((r) => r.id === getRepoIdFromWorktreeId(worktreeId)))
  const fetchPRChecks = useAppStore((s) => s.fetchPRChecks)
  const [checks, setChecks] = useState<PRCheckDetail[] | null>(null)
  const head = review.headSha ?? null
  const owner = review.githubRepository?.owner ?? null
  const name = review.githubRepository?.repo ?? null
  useEffect(() => {
    if (!repo) {
      return
    }
    let alive = true
    let running = true
    let lastLoadAt = 0
    const prRepo = owner && name ? { owner, repo: name } : null
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
    const stop = installWindowVisibilityInterval({
      run: () => {
        if (running || Date.now() - lastLoadAt >= POLL_SETTLED_MS) {
          void load()
        }
      },
      intervalMs: POLL_RUNNING_MS,
      slowWhileUnfocused: true
    })
    return () => {
      alive = false
      stop()
    }
  }, [repo, fetchPRChecks, review.number, owner, name, head])
  return checks
}

/**
 * The conversation's PR checks plus "Fix errors" and its autofix: once per pushed head, when every
 * check settled and some failed, the failures go to the conversation's idle agent.
 */
export function useZotzPrChecksMonitor(
  worktreeId: string,
  review: ZotzReviewRef
): ZotzPrChecksMonitor {
  const t = useTranslate()
  const repo = useAppStore((s) => s.repos.find((r) => r.id === getRepoIdFromWorktreeId(worktreeId)))
  const checks = usePolledChecks(worktreeId, review)
  const autofix = useZotzPrAutofix(worktreeId)
  const [fixing, setFixing] = useState(false)

  const sorted = useMemo(
    () =>
      (checks ?? [])
        .map((check) => ({ check, kind: zotzCheckKind(check) }))
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]),
    [checks]
  )
  const counts = useMemo(() => {
    const result: Record<ZotzCheckKind, number> = { failed: 0, running: 0, passed: 0, skipped: 0 }
    for (const { kind } of sorted) {
      result[kind] += 1
    }
    return result
  }, [sorted])

  const report = useCallback(
    (outcome: ZotzFixChecksOutcome | null) => {
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

  const run = useCallback(
    (onlyIfIdle: boolean): Promise<ZotzFixChecksOutcome | null> => {
      if (!repo || !checks || fixing) {
        return Promise.resolve(null)
      }
      setFixing(true)
      return fixZotzPrChecks({ worktreeId, repo, review, checks, onlyIfIdle }).finally(() =>
        setFixing(false)
      )
    },
    [repo, checks, fixing, worktreeId, review]
  )

  const head = review.headSha ?? `pr-${review.number}`
  // A head counts as failed only once nothing still runs: a partial failure may still be retried.
  const settledWithFailures = counts.failed > 0 && counts.running === 0
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
    void run(true).then((outcome) => {
      autofixInFlight.current = false
      if (outcome === 'sent') {
        markZotzPrAutofixSent(worktreeId, head)
        report(outcome)
      }
    })
  }, [autofix.enabled, autofix.lastSentHead, settledWithFailures, head, run, worktreeId, report])

  return {
    checks,
    sorted,
    counts,
    fixing,
    autofixEnabled: autofix.enabled,
    fix: () => void run(false).then(report)
  }
}
