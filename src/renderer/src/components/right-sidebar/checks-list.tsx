import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useActiveWorktree } from '@/store/selectors'
import { useAppStore } from '@/store'
import { useCheckDetailsResize } from './check-details-resize'
import { ChecksListSummary } from './checks-list-summary'
import { ChecksListRow, type ChecksListRowModel } from './checks-list-row'
import {
  CHECK_SORT_ORDER,
  getCheckDetailsKey,
  isFailedCheck,
  type CheckDetailsLoadState
} from './checks-list-model'
import type { CheckDetailsStickySurface } from './checks-list-details'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'

/** Renders the checks summary bar + scrollable check list. */
export function ChecksList({
  checks,
  checksLoading,
  checkDetailsContextKey,
  onLoadCheckDetails,
  worktreeId: worktreeIdOverride,
  detailsStickySurface = 'sidebar'
}: {
  checks: PRCheckDetail[]
  checksLoading: boolean
  checkDetailsContextKey: string
  onLoadCheckDetails?: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
  /** Why: folder-workspace PR checks render rows for attached worktrees, not the active one. */
  worktreeId?: string
  detailsStickySurface?: CheckDetailsStickySurface
}): React.JSX.Element {
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
  const sorted = useMemo(
    () =>
      [...checks].sort(
        (a, b) =>
          (CHECK_SORT_ORDER[a.conclusion ?? 'pending'] ?? 3) -
          (CHECK_SORT_ORDER[b.conclusion ?? 'pending'] ?? 3)
      ),
    [checks]
  )
  const rows = useMemo(
    () =>
      sorted.map((check, index) => ({
        check,
        key: getCheckDetailsKey(checkDetailsContextKey, check, index)
      })),
    [checkDetailsContextKey, sorted]
  )
  const passingCount = checks.filter((c) => c.conclusion === 'success').length
  const failingCount = checks.filter(
    (c) =>
      c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out'
  ).length
  const pendingCount = checks.filter(
    (c) => c.conclusion === 'pending' || c.conclusion === null
  ).length

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
        if (!cached?.details) {
          continue
        }
        if (
          cached.details.status !== row.check.status ||
          cached.details.conclusion !== row.check.conclusion
        ) {
          delete next[row.key]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [rows])

  const requestCheckDetails = useCallback(
    (row: ChecksListRowModel) => {
      if (detailsByCheckKey[row.key]?.loading || detailsByCheckKey[row.key]?.details) {
        return
      }
      if (!row.check.checkRunId && !row.check.workflowRunId && !row.check.url) {
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
      setDetailsByCheckKey((current) => ({
        ...current,
        [row.key]: { loading: true, details: null, error: null }
      }))
      void onLoadCheckDetails(row.check)
        .then((details) => {
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => ({
            ...current,
            [row.key]: {
              loading: false,
              details,
              error: details
                ? null
                : translate(
                    'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                    'No inline details are available for this check.'
                  )
            }
          }))
        })
        .catch((err) => {
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => ({
            ...current,
            [row.key]: {
              loading: false,
              details: null,
              error:
                err instanceof Error
                  ? err.message
                  : translate(
                      'auto.components.right.sidebar.checks.panel.content.4e0f0a5d3d',
                      'Failed to load check details.'
                    )
            }
          }))
        })
    },
    [checkDetailsContextKey, detailsByCheckKey, onLoadCheckDetails]
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
        details: detailsState.details ?? null,
        loading: detailsState.loading ?? false,
        error: detailsState.error ?? null
      })
    }
  }, [
    checkDetailsContextKey,
    detailsByCheckKey,
    patchOpenCheckRunDetails,
    resolvedWorktreeId,
    rows
  ])

  const toggleCheckExpanded = useCallback(
    (row: ChecksListRowModel) => {
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

  return (
    <>
      {checks.length > 0 && (
        <ChecksListSummary
          checksExpanded={checksExpanded}
          passingCount={passingCount}
          failingCount={failingCount}
          pendingCount={pendingCount}
          checksLoading={checksLoading}
          onToggle={() => setChecksExpanded((expanded) => !expanded)}
        />
      )}
      {checksLoading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : checks.length === 0 ? (
        <div className="px-4 py-8 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.991f50c7e4',
            'No checks configured'
          )}
        </div>
      ) : !checksExpanded ? null : (
        <>
          <div
            className={cn('py-1', shouldConstrainCheckList && 'overflow-y-auto scrollbar-sleek')}
            style={shouldConstrainCheckList ? { maxHeight: detailsHeight } : undefined}
          >
            {rows.map((row) => (
              <ChecksListRow
                key={row.key}
                row={row}
                expanded={expandedCheckKeys.has(row.key)}
                detailsState={detailsByCheckKey[row.key]}
                checkDetailsContextKey={checkDetailsContextKey}
                resolvedWorktreeId={resolvedWorktreeId}
                detailsStickySurface={detailsStickySurface}
                onToggle={toggleCheckExpanded}
              />
            ))}
          </div>
          {shouldConstrainCheckList && (
            <div
              role="separator"
              aria-orientation="horizontal"
              title={translate(
                'auto.components.right.sidebar.checks.panel.content.7f793b571d',
                'Drag to resize checks'
              )}
              className="group flex h-2 cursor-row-resize items-center border-b border-border"
              onMouseDown={handleResizeStart}
            >
              <div className="h-px w-full bg-transparent transition-colors group-hover:bg-ring/40" />
            </div>
          )}
          {checks.length >= 100 && (
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.cbcc4ab3db',
                'Showing first 100 checks'
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}
