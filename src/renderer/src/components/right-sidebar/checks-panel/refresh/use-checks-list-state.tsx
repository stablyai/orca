import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { useActiveWorktree } from '@/store/selectors'
import type { GitLabProjectRef } from '../../../../../../shared/gitlab-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../../shared/github/check-types'
import type { GitHubRepositoryIdentity } from '../../../../../../shared/github/pull-request-types'
import { sortChecksBySeverity } from '../../../../../../shared/source-control/checks/pr-check-severity-order'
import { summarizeProviderChecks } from '../../../../../../shared/source-control/checks/provider-check-summary'
import { createCheckRunDetailsRequestId } from '@/components/editor/check-details/actions/check-run-details-tab'
import { translate } from '@/i18n/i18n'
import { useCheckDetailsResize } from '../logs/check-details-resize'
import {
  type CheckDetailsLoadState,
  type CheckDetailsStickySurface,
  getCheckDetailsKey,
  isFailedCheck
} from '../presentation/check-details-model'

export type ChecksListProps = {
  checks: PRCheckDetail[]
  /** A GitLab parent pipeline: shown as its provider link above the job rows, never as a job. */
  pipelineCheck?: PRCheckDetail | null
  /** Set when the last read failed; replaces the empty-list copy. */
  checksError?: string | null
  checksLoading: boolean
  checkDetailsContextKey: string
  onLoadCheckDetails?: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
  worktreeId?: string
  detailsStickySurface?: CheckDetailsStickySurface
  getGitLabProjectRef?: () => GitLabProjectRef | null
  githubRepository?: GitHubRepositoryIdentity | null
}

export function useChecksListState({
  checks,
  checkDetailsContextKey,
  onLoadCheckDetails,
  worktreeId: worktreeIdOverride,
  getGitLabProjectRef,
  githubRepository
}: ChecksListProps) {
  const activeWorktree = useActiveWorktree()
  const resolvedWorktreeId = worktreeIdOverride ?? activeWorktree?.id ?? null
  const patchOpenCheckRunDetails = useAppStore((s) => s.patchOpenCheckRunDetails)
  const [checksExpanded, setChecksExpanded] = useState(true)
  const [expandedCheckKeys, setExpandedCheckKeys] = useState<Set<string>>(new Set())
  const [detailsByCheckKey, setDetailsByCheckKey] = useState<Record<string, CheckDetailsLoadState>>(
    {}
  )
  const detailsContextRef = useRef(checkDetailsContextKey)
  // Expanded details use the sidebar scroller; constraining the list too would create nested scrollbars.
  const shouldConstrainCheckList = checksExpanded && expandedCheckKeys.size === 0
  const { detailsHeight, handleResizeStart } = useCheckDetailsResize(
    shouldConstrainCheckList && checks.length > 0
  )
  detailsContextRef.current = checkDetailsContextKey
  const sorted = React.useMemo(() => sortChecksBySeverity(checks), [checks])
  const rows = React.useMemo(
    () =>
      sorted.map((check, index) => ({
        check,
        key: getCheckDetailsKey(checkDetailsContextKey, check, index)
      })),
    [checkDetailsContextKey, sorted]
  )
  // Share the pill's classifier for skipped passes and completed-without-verdict unresolved checks.
  const {
    passed: passingCount,
    failed: inclusiveFailingCount,
    cancelled: cancelledCount = 0,
    pending: pendingCount,
    neutral: neutralCount
  } = summarizeProviderChecks(checks)
  const failingCount = inclusiveFailingCount - cancelledCount

  // Reconcile during render so each checks poll commits once instead of twice.
  const [reconciledFor, setReconciledFor] = useState<{
    rows: typeof rows
    contextKey: string
  } | null>(null)
  if (reconciledFor?.rows !== rows) {
    setReconciledFor({ rows, contextKey: checkDetailsContextKey })
    const nextDetails = reconcileCheckDetailsWithRows(detailsByCheckKey, rows)
    if (nextDetails !== detailsByCheckKey) {
      setDetailsByCheckKey(nextDetails)
    }
    const autoExpandKey =
      reconciledFor?.contextKey !== checkDetailsContextKey
        ? rows.find((row) => isFailedCheck(row.check))?.key
        : undefined
    const nextExpanded = reconcileExpandedCheckKeys(expandedCheckKeys, rows, autoExpandKey)
    if (nextExpanded !== expandedCheckKeys) {
      setExpandedCheckKeys(nextExpanded)
    }
  }

  const requestCheckDetails = useCallback(
    (row: { check: PRCheckDetail; key: string }) => {
      if (detailsByCheckKey[row.key]?.loading || detailsByCheckKey[row.key]?.details) {
        return
      }
      if (
        !row.check.checkRunId &&
        !row.check.workflowRunId &&
        !row.check.url &&
        !row.check.gitlabJobId
      ) {
        setDetailsByCheckKey((current) => ({
          ...current,
          [row.key]: {
            loading: false,
            details: null,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
              'No inline details are available for this check.'
            )
          }
        }))
        return
      }
      if (!onLoadCheckDetails) {
        setDetailsByCheckKey((current) => ({
          ...current,
          [row.key]: {
            loading: false,
            details: null,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
              'No inline details are available for this check.'
            )
          }
        }))
        return
      }
      const requestContextKey = checkDetailsContextKey
      const requestId = createCheckRunDetailsRequestId()
      const retryError = detailsByCheckKey[row.key]?.error ?? null
      setDetailsByCheckKey((current) => ({
        ...current,
        [row.key]: { requestId, loading: true, details: null, error: retryError }
      }))
      if (resolvedWorktreeId) {
        patchOpenCheckRunDetails(resolvedWorktreeId, requestContextKey, row.check, {
          requestId,
          details: null,
          loading: true,
          error: retryError,
          githubRepository: githubRepository ?? null,
          gitlabProjectRef: getGitLabProjectRef?.() ?? null
        })
      }
      const request = Promise.resolve().then(() => onLoadCheckDetails(row.check))
      void request
        .then((details) => {
          if (resolvedWorktreeId) {
            patchOpenCheckRunDetails(resolvedWorktreeId, requestContextKey, row.check, {
              requestId,
              details,
              loading: false,
              error: details
                ? null
                : translate(
                    'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                    'No inline details are available for this check.'
                  ),
              githubRepository: githubRepository ?? null,
              gitlabProjectRef: getGitLabProjectRef?.() ?? null
            })
          }
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => {
            if (current[row.key]?.requestId !== requestId) {
              return current
            }
            return {
              ...current,
              [row.key]: {
                requestId,
                loading: false,
                details,
                error: details
                  ? null
                  : translate(
                      'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                      'No inline details are available for this check.'
                    ),
                // A null detail result is final only for this state; rearm when the job moves on.
                errorAt: details
                  ? undefined
                  : { status: row.check.status, conclusion: row.check.conclusion }
              }
            }
          })
        })
        .catch((err) => {
          const error =
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.right.sidebar.checks.panel.content.e45324fbed',
                  'Failed to load check details.'
                )
          if (resolvedWorktreeId) {
            patchOpenCheckRunDetails(resolvedWorktreeId, requestContextKey, row.check, {
              requestId,
              details: null,
              loading: false,
              error,
              githubRepository: githubRepository ?? null,
              gitlabProjectRef: getGitLabProjectRef?.() ?? null
            })
          }
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => {
            if (current[row.key]?.requestId !== requestId) {
              return current
            }
            return {
              ...current,
              [row.key]: {
                requestId,
                loading: false,
                details: null,
                error,
                errorAt: { status: row.check.status, conclusion: row.check.conclusion }
              }
            }
          })
        })
    },
    [
      checkDetailsContextKey,
      detailsByCheckKey,
      getGitLabProjectRef,
      githubRepository,
      onLoadCheckDetails,
      patchOpenCheckRunDetails,
      resolvedWorktreeId
    ]
  )

  useEffect(() => {
    if (!checksExpanded) {
      return
    }
    for (const row of rows) {
      if (expandedCheckKeys.has(row.key) && !detailsByCheckKey[row.key]) {
        requestCheckDetails(row)
      }
    }
  }, [checksExpanded, detailsByCheckKey, expandedCheckKeys, requestCheckDetails, rows])

  useEffect(() => {
    if (!resolvedWorktreeId) {
      return
    }
    for (const row of rows) {
      const detailsState = detailsByCheckKey[row.key]
      if (!detailsState) {
        continue
      }
      patchOpenCheckRunDetails(resolvedWorktreeId, checkDetailsContextKey, row.check, {
        requestId: detailsState.requestId,
        details: detailsState.details ?? null,
        loading: detailsState.loading ?? false,
        error: detailsState.error ?? null,
        githubRepository: githubRepository ?? null,
        gitlabProjectRef: getGitLabProjectRef?.() ?? null
      })
    }
  }, [
    checkDetailsContextKey,
    detailsByCheckKey,
    getGitLabProjectRef,
    githubRepository,
    patchOpenCheckRunDetails,
    resolvedWorktreeId,
    rows
  ])

  const toggleCheckExpanded = useCallback(
    (row: { check: PRCheckDetail; key: string }) => {
      const willExpand = !expandedCheckKeys.has(row.key)
      setExpandedCheckKeys((current) => {
        const next = new Set(current)
        if (next.has(row.key)) {
          next.delete(row.key)
        } else {
          next.add(row.key)
        }
        return next
      })
      if (willExpand) {
        requestCheckDetails(row)
      }
    },
    [expandedCheckKeys, requestCheckDetails]
  )
  return {
    resolvedWorktreeId,
    checksExpanded,
    setChecksExpanded,
    expandedCheckKeys,
    detailsByCheckKey,
    shouldConstrainCheckList,
    detailsHeight,
    handleResizeStart,
    rows,
    passingCount,
    failingCount,
    cancelledCount,
    pendingCount,
    neutralCount,
    toggleCheckExpanded,
    requestCheckDetails
  }
}

type CheckRow = { check: PRCheckDetail; key: string }

function reconcileCheckDetailsWithRows(
  current: Record<string, CheckDetailsLoadState>,
  rows: readonly CheckRow[]
): Record<string, CheckDetailsLoadState> {
  const rowByKey = new Map(rows.map((row) => [row.key, row]))
  let changed = false
  const next: Record<string, CheckDetailsLoadState> = {}
  for (const [key, cached] of Object.entries(current)) {
    const row = rowByKey.get(key)
    if (!row) {
      changed = true
      continue
    }
    // Why: a failed load (GitLab auth blip, 404, offline) otherwise pins its error
    // forever — there is no retry affordance — so re-arm it once the job moves on.
    const stale =
      !cached.loading &&
      (cached.details
        ? cached.details.status !== row.check.status ||
          cached.details.conclusion !== row.check.conclusion
        : Boolean(
            cached.errorAt &&
            (cached.errorAt.status !== row.check.status ||
              cached.errorAt.conclusion !== row.check.conclusion)
          ))
    if (stale) {
      changed = true
      continue
    }
    next[key] = cached
  }
  return changed ? next : current
}

function reconcileExpandedCheckKeys(
  current: Set<string>,
  rows: readonly CheckRow[],
  autoExpandKey: string | undefined
): Set<string> {
  const validKeys = new Set(rows.map((row) => row.key))
  const next = new Set([...current].filter((key) => validKeys.has(key)))
  if (autoExpandKey !== undefined) {
    next.add(autoExpandKey)
  }
  return next.size === current.size && [...next].every((key) => current.has(key)) ? current : next
}
