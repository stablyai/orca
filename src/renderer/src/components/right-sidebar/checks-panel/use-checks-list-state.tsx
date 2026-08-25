import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import type { GitLabProjectRef } from '../../../../../shared/gitlab-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../shared/github/check-types'
import type { GitHubRepositoryIdentity } from '../../../../../shared/github/pull-request-types'
import { sortChecksBySeverity } from '../../../../../shared/pr-check-severity-order'
import { summarizeProviderChecks } from '../../../../../shared/provider-check-summary'
import { createCheckRunDetailsRequestId } from '@/components/editor/check-run-details-tab'
import { translate } from '@/i18n/i18n'
import { useCheckDetailsResize } from '../check-details-resize'
import {
  type CheckDetailsLoadState,
  type CheckDetailsStickySurface,
  getCheckDetailsKey,
  isFailedCheck
} from './check-details-model'

export type ChecksListProps = {
  checks: PRCheckDetail[]
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
  const autoExpandedContextRef = useRef<string | null>(null)
  // Why: expanded check details already sit inside the sidebar scroller; keeping
  // the list scroller too creates nested scrollbars around CI annotations.
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
  // Why: every header count comes from the same classifier the checks pill uses — counting only
  // `success` made a 2-success/3-skipped PR say "2 passing" next to "5/5 passed", and treating a
  // null conclusion as pending kept a completed-but-unresolved check spinning forever.
  const {
    passed: passingCount,
    failed: failingCount,
    pending: pendingCount,
    neutral: neutralCount
  } = summarizeProviderChecks(checks)

  useEffect(() => {
    const validKeys = new Set(rows.map((row) => row.key))
    setDetailsByCheckKey((current) => {
      const next: Record<string, CheckDetailsLoadState> = {}
      for (const [key, state] of Object.entries(current)) {
        if (validKeys.has(key)) {
          next[key] = state
        }
      }
      return next
    })
    setExpandedCheckKeys((current) => {
      const next = new Set([...current].filter((key) => validKeys.has(key)))
      if (autoExpandedContextRef.current !== checkDetailsContextKey) {
        const firstFailed = rows.find((row) => isFailedCheck(row.check))
        if (firstFailed) {
          next.add(firstFailed.key)
        }
        autoExpandedContextRef.current = checkDetailsContextKey
      }
      return next
    })
  }, [checkDetailsContextKey, rows])

  useEffect(() => {
    setDetailsByCheckKey((current) => {
      let changed = false
      const next: Record<string, CheckDetailsLoadState> = { ...current }
      for (const row of rows) {
        const cached = next[row.key]
        if (!cached || cached.loading) {
          continue
        }
        // Why: a failed load (GitLab auth blip, 404, offline) otherwise pins its error
        // forever — there is no retry affordance — so re-arm it once the job moves on.
        const stale = cached.details
          ? cached.details.status !== row.check.status ||
            cached.details.conclusion !== row.check.conclusion
          : Boolean(
              cached.errorAt &&
              (cached.errorAt.status !== row.check.status ||
                cached.errorAt.conclusion !== row.check.conclusion)
            )
        if (stale) {
          delete next[row.key]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [rows])

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
                // Why: a detail-less result is only final for this status — re-arm the retry once the job moves on.
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
    pendingCount,
    neutralCount,
    toggleCheckExpanded,
    requestCheckDetails
  }
}
