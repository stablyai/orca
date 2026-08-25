import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CircleDashed, LoaderCircle } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { CHECK_COLOR } from '@/components/right-sidebar/checks-panel-content'
import {
  createGitHubChecksTabState,
  resolveGitHubChecksTabState,
  toggleGitHubChecksTabExpandedKey
} from '@/components/github-checks-tab-state'
import {
  canUseGitHubRepoContext,
  getGitHubSourceRuntimeHost
} from '@/lib/github-source-runtime-context'
import { getBrokenChecks } from '@/components/pr-checks-fix-prompt'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { sortChecksBySeverity } from '../../../../../shared/pr-check-severity-order'
import {
  getCheckCountChips,
  getCheckCounts,
  getChecksSummaryLabel
} from '@/components/pr-check-counts'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { getCheckDetailsKey } from '@/components/github/pr-check-presentation'
import { getChecksTabSummaryPresentation } from './checks-tab-summary'
import { renderCheckRow } from './checks-tab-check-row'
import {
  fixBrokenGitHubChecks,
  refreshGitHubChecksTab,
  rerunGitHubChecksTab
} from './checks-tab-actions'
import { requestGitHubCheckDetails } from './checks-tab-request-details'
import { ChecksTabActions, ChecksTabCompactHeader } from './checks-tab-header'

export function ChecksTab({
  item,
  repoPath,
  repoId,
  sourceContext,
  headSha,
  checks,
  loading,
  variant = 'compact',
  onChecksUpdated
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  headSha: string | undefined
  checks: GitHubWorkItemDetails['checks']
  loading: boolean
  variant?: 'compact' | 'page'
  onChecksUpdated: (checks: PRCheckDetail[]) => void
}): React.JSX.Element {
  const [fixingChecks, setFixingChecks] = useState(false)
  const mountedRef = useMountedRef()
  const prRepo = useMemo(() => resolvePullRequestRepo(item), [item])
  const nextCheckDetailsRequestIdRef = useRef(0)
  const checkDetailsContextKey = [
    sourceContext ? getTaskSourceCacheScope(sourceContext) : 'local',
    repoId ?? item.repoId ?? '',
    repoPath ?? '',
    prRepo ? githubRepoIdentityKey(prRepo) : '',
    item.id,
    item.number,
    headSha ?? ''
  ].join('\0')
  const [checksState, setChecksState] = useState(() =>
    createGitHubChecksTabState(checks, checkDetailsContextKey)
  )
  const resolvedChecksState = resolveGitHubChecksTabState(
    checksState,
    checks,
    checkDetailsContextKey
  )
  const committedChecksContextOwnerRef = useRef(resolvedChecksState.contextOwner)
  const nextChecksRefreshRequestIdRef = useRef(0)
  const activeChecksRefreshRequestIdRef = useRef<number | null>(null)
  const [refreshingOwner, setRefreshingOwner] = useState<{
    contextOwner: object
    requestId: number
  } | null>(null)
  const refreshing = refreshingOwner?.contextOwner === resolvedChecksState.contextOwner
  const [rerunningOwner, setRerunningOwner] = useState<object | null>(null)
  const rerunning = rerunningOwner === resolvedChecksState.contextOwner
  useLayoutEffect(() => {
    committedChecksContextOwnerRef.current = resolvedChecksState.contextOwner
  }, [resolvedChecksState.contextOwner])
  if (resolvedChecksState !== checksState) {
    // Why: a parent check refresh replaces the source list; reset local state before stale rows/details can paint.
    setChecksState(resolvedChecksState)
  }
  const { localChecks, expandedCheckKey, detailsByCheckKey } = resolvedChecksState
  const list = useMemo(() => localChecks ?? checks ?? [], [checks, localChecks])
  const runtimeHost = getGitHubSourceRuntimeHost(sourceContext)
  const canUseChecksRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const sorted = sortChecksBySeverity(list)
  const failedChecks = getBrokenChecks(list)
  const counts = getCheckCounts(list)
  const summaryLabel = getChecksSummaryLabel(list)
  const { SummaryIcon, summaryColor } = getChecksTabSummaryPresentation(counts)
  const canFixBrokenChecks = Boolean((repoId ?? item.repoId) && failedChecks.length > 0)

  const handleRefresh = useCallback(
    async (expectedContextOwner?: object): Promise<PRCheckDetail[] | null> =>
      refreshGitHubChecksTab(
        {
          canUseChecksRepoContext,
          runtimeHost,
          sourceContext,
          repoId,
          repoPath,
          itemNumber: item.number,
          itemRepoId: item.repoId,
          headSha,
          prRepo,
          mountedRef,
          committedChecksContextOwnerRef,
          nextChecksRefreshRequestIdRef,
          activeChecksRefreshRequestIdRef,
          nextCheckDetailsRequestIdRef,
          setChecksState,
          setRefreshingOwner,
          setRerunningOwner,
          onChecksUpdated
        },
        expectedContextOwner
      ),
    [
      canUseChecksRepoContext,
      headSha,
      item.number,
      item.repoId,
      mountedRef,
      onChecksUpdated,
      runtimeHost,
      prRepo,
      repoId,
      repoPath,
      sourceContext
    ]
  )

  const handleRerun = useCallback(
    async (failedOnly: boolean): Promise<void> =>
      rerunGitHubChecksTab(
        {
          canUseChecksRepoContext,
          runtimeHost,
          sourceContext,
          repoId,
          repoPath,
          itemNumber: item.number,
          itemRepoId: item.repoId,
          headSha,
          prRepo,
          mountedRef,
          committedChecksContextOwnerRef,
          nextChecksRefreshRequestIdRef,
          activeChecksRefreshRequestIdRef,
          nextCheckDetailsRequestIdRef,
          setChecksState,
          setRefreshingOwner,
          setRerunningOwner,
          onChecksUpdated
        },
        failedOnly,
        rerunning
      ),
    [
      canUseChecksRepoContext,
      headSha,
      item.number,
      item.repoId,
      mountedRef,
      onChecksUpdated,
      prRepo,
      runtimeHost,
      rerunning,
      repoId,
      repoPath,
      sourceContext
    ]
  )

  const handleFixBrokenChecks = useCallback(async (): Promise<void> => {
    await fixBrokenGitHubChecks({
      item,
      repoId,
      fixingChecks,
      failedChecksLength: failedChecks.length,
      list,
      setFixingChecks
    })
  }, [failedChecks.length, fixingChecks, item, list, repoId])

  const requestCheckDetails = useCallback(
    (check: PRCheckDetail, key: string): void => {
      requestGitHubCheckDetails(
        {
          canUseChecksRepoContext,
          runtimeHost,
          sourceContext,
          repoId,
          repoPath,
          itemNumber: item.number,
          itemRepoId: item.repoId,
          headSha,
          prRepo,
          mountedRef,
          committedChecksContextOwnerRef,
          nextChecksRefreshRequestIdRef,
          activeChecksRefreshRequestIdRef,
          nextCheckDetailsRequestIdRef,
          setChecksState,
          setRefreshingOwner,
          setRerunningOwner,
          onChecksUpdated
        },
        check,
        key
      )
    },
    [
      canUseChecksRepoContext,
      headSha,
      item.number,
      item.repoId,
      mountedRef,
      onChecksUpdated,
      runtimeHost,
      prRepo,
      repoId,
      repoPath,
      sourceContext
    ]
  )

  const handleToggleCheckDetails = useCallback(
    (check: PRCheckDetail): void => {
      const key = getCheckDetailsKey(check)
      setChecksState((current) => toggleGitHubChecksTabExpandedKey(current, key))
      if (detailsByCheckKey[key]) {
        return
      }
      requestCheckDetails(check, key)
    },
    [detailsByCheckKey, requestCheckDetails]
  )

  const { refreshAction, rerunAction, secondaryActions, actions } = ChecksTabActions({
    variant,
    canUseChecksRepoContext,
    refreshing,
    rerunning,
    fixingChecks,
    canFixBrokenChecks,
    failedChecksLength: failedChecks.length,
    listLength: list.length,
    onRefresh: () => {
      void handleRefresh()
    },
    onRerun: (failedOnly) => {
      void handleRerun(failedOnly)
    },
    onFix: () => {
      void handleFixBrokenChecks()
    }
  })
  const compactHeader = (
    <ChecksTabCompactHeader
      SummaryIcon={SummaryIcon}
      summaryColor={summaryColor}
      counts={counts}
      summaryLabel={summaryLabel}
      listLength={list.length}
      refreshAction={refreshAction}
      rerunAction={rerunAction}
      secondaryActions={secondaryActions}
    />
  )

  if (loading && list.length === 0) {
    return (
      <>
        {variant === 'compact' ? compactHeader : null}
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      </>
    )
  }
  if (list.length === 0) {
    if (variant === 'page') {
      return (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {translate('auto.components.GitHubItemDialog.ecffebc251', 'No checks found')}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.GitHubItemDialog.90020cc1f3',
                  'This pull request has no reported checks yet.'
                )}
              </span>
            </div>
            {actions}
          </div>
        </div>
      )
    }
    return (
      <>
        {compactHeader}
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
          <CircleDashed className="size-4 text-muted-foreground/60" />
          <div className="text-[12px] text-muted-foreground">
            {translate('auto.components.GitHubItemDialog.e52bed9264', 'No checks reported yet')}
          </div>
        </div>
      </>
    )
  }
  if (variant === 'page') {
    const countChips = getCheckCountChips(counts)
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <SummaryIcon
            className={cn(
              'size-4 shrink-0',
              summaryColor,
              counts.pending > 0 && counts.failing === 0 && 'animate-spin'
            )}
          />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{summaryLabel}</span>
            {countChips.length > 1 && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {countChips.map((chip, i) => (
                  <React.Fragment key={chip.tone}>
                    {i > 0 && <span className="opacity-40">·</span>}
                    <span className={CHECK_COLOR[chip.tone]}>{chip.label}</span>
                  </React.Fragment>
                ))}
              </span>
            )}
          </div>
          {actions}
        </div>
        <div className="overflow-hidden rounded-lg border border-border/50 bg-card/50 shadow-xs">
          {sorted.map((check, index) => (
            <div
              key={getCheckDetailsKey(check)}
              className={cn(index > 0 && 'border-t border-border/40')}
            >
              {renderCheckRow({
                check,
                variant,
                expandedCheckKey,
                detailsByCheckKey,
                onToggle: handleToggleCheckDetails,
                requestCheckDetails
              })}
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <>
      {compactHeader}
      <div className="max-h-[280px] overflow-y-auto p-1 scrollbar-sleek">
        {sorted.map((check) =>
          renderCheckRow({
            check,
            variant,
            expandedCheckKey,
            detailsByCheckKey,
            onToggle: handleToggleCheckDetails,
            requestCheckDetails
          })
        )}
      </div>
    </>
  )
}
