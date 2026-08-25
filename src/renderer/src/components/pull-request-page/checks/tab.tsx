import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CircleDashed } from 'lucide-react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel-content'
import {
  createGitHubChecksTabState,
  resolveGitHubChecksTabState,
  toggleGitHubChecksTabExpandedKey
} from '@/components/github-checks-tab-state'
import { getCheckDetailsKey } from '@/components/github/pr-check-presentation'
import { getCheckCounts, getChecksSummaryLabel } from '@/components/pr-check-counts'
import { getBrokenChecks } from '@/components/pr-checks-fix-prompt'
import { sortChecksBySeverity } from '../../../../../shared/pr-check-severity-order'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import {
  canUseGitHubRepoContext,
  getGitHubSourceRuntimeHost
} from '@/lib/github-source-runtime-context'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { resolveSourceControlActionRecipe } from '../../../../../shared/source-control-ai'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { refreshPullRequestChecks } from './refresh'
import { rerunPullRequestChecks } from './rerun'
import { requestPullRequestCheckDetails } from './details-request'
import { fixBrokenPullRequestChecks } from './fix-launch'
import { ChecksCompactHeader, buildChecksToolbar } from './toolbar'
import { CheckRow } from './row'
import { ChecksFixDialog } from './fix-dialog'
import { ChecksTabLayouts } from './layouts'

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
  const targetRepoId = repoId ?? item.repoId
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const repo = useAppStore((s) =>
    targetRepoId ? (s.repos.find((candidate) => candidate.id === targetRepoId) ?? null) : null
  )
  const repos = useAppStore((s) => s.repos)
  const projects = useAppStore((s) => s.projects)
  const [fixingChecks, setFixingChecks] = useState(false)
  const [fixChecksComposerPrompt, setFixChecksComposerPrompt] = useState<string | null>(null)
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
    // Why: reconcile before paint when a parent check refresh replaces the source list, so stale rows/details never show.
    setChecksState(resolvedChecksState)
  }
  const { localChecks, expandedCheckKey, detailsByCheckKey } = resolvedChecksState
  const list = useMemo(() => localChecks ?? checks ?? [], [checks, localChecks])
  const fixChecksRecipe = useMemo(
    () =>
      resolveSourceControlActionRecipe({
        settings,
        repo,
        actionId: 'fixChecks'
      }),
    [repo, settings]
  )
  const fixChecksLaunchPlatform = useMemo(
    () =>
      resolveSourceControlLaunchPlatform({
        connectionId: repo?.connectionId ?? null,
        worktreePath: repo?.path ?? null,
        projectRuntime: repo?.connectionId
          ? undefined
          : getLocalRepoProjectExecutionRuntimeContext(
              // Why: repo-scoped resolution only reads repos/projects/settings, and subscribing keeps the launch platform fresh.
              {
                activeRepoId: null,
                activeWorktreeId: null,
                projects,
                repos,
                settings,
                worktreesByRepo: {}
              },
              repo?.id,
              CLIENT_PLATFORM
            )
      }),
    [projects, repo?.connectionId, repo?.id, repo?.path, repos, settings]
  )
  // Why: parses a fresh host object per call, so memoize to keep the check action callbacks stable.
  const runtimeHost = useMemo(() => getGitHubSourceRuntimeHost(sourceContext), [sourceContext])
  const canUseChecksRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const sorted = sortChecksBySeverity(list)
  const failedChecks = getBrokenChecks(list)
  const counts = getCheckCounts(list)
  const summaryLabel = getChecksSummaryLabel(list)
  // Why: keying the green tick off `list.length` painted an all-neutral PR green above the words
  // "0 of N checks passing"; nothing passed, so it reads unresolved like the checks pill does.
  const SummaryIcon =
    counts.failing > 0
      ? CHECK_ICON.failure
      : counts.needsAction > 0
        ? CHECK_ICON.action_required
        : counts.pending > 0
          ? CHECK_ICON.pending
          : counts.passing > 0
            ? CHECK_ICON.success
            : CircleDashed
  const summaryColor =
    counts.failing > 0
      ? CHECK_COLOR.failure
      : counts.needsAction > 0
        ? CHECK_COLOR.action_required
        : counts.pending > 0
          ? CHECK_COLOR.pending
          : counts.passing > 0
            ? CHECK_COLOR.success
            : 'text-muted-foreground'
  const canFixBrokenChecks = Boolean((repoId ?? item.repoId) && failedChecks.length > 0)

  const handleRefresh = useCallback(
    async (expectedContextOwner?: object) =>
      refreshPullRequestChecks({
        canUseChecksRepoContext,
        expectedContextOwner,
        committedChecksContextOwnerRef,
        nextChecksRefreshRequestIdRef,
        activeChecksRefreshRequestIdRef,
        setRefreshingOwner,
        setChecksState,
        runtimeHost,
        sourceContext,
        repoId,
        repoPath,
        item,
        headSha,
        prRepo,
        mountedRef,
        onChecksUpdated
      }),
    [
      canUseChecksRepoContext,
      headSha,
      item,
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
    async (failedOnly: boolean) =>
      rerunPullRequestChecks({
        canUseChecksRepoContext,
        rerunning,
        committedChecksContextOwnerRef,
        setRerunningOwner,
        runtimeHost,
        sourceContext,
        repoId,
        repoPath,
        item,
        headSha,
        prRepo,
        failedOnly,
        mountedRef,
        handleRefresh
      }),
    [
      canUseChecksRepoContext,
      handleRefresh,
      headSha,
      item,
      mountedRef,
      prRepo,
      runtimeHost,
      rerunning,
      repoId,
      repoPath,
      sourceContext
    ]
  )

  const requestCheckDetails = useCallback(
    (check: PRCheckDetail, key: string): void => {
      requestPullRequestCheckDetails({
        canUseChecksRepoContext,
        check,
        key,
        nextCheckDetailsRequestIdRef,
        mountedRef,
        setChecksState,
        runtimeHost,
        sourceContext,
        repoId,
        repoPath,
        item,
        prRepo
      })
    },
    [
      canUseChecksRepoContext,
      item,
      mountedRef,
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

  const { refreshAction, rerunAction, secondaryActions, actions } = buildChecksToolbar({
    variant,
    canUseChecksRepoContext,
    refreshing,
    rerunning,
    fixingChecks,
    canFixBrokenChecks,
    failedChecksCount: failedChecks.length,
    listLength: list.length,
    onRefresh: () => {
      void handleRefresh()
    },
    onFix: () => {
      void fixBrokenPullRequestChecks({
        targetRepoId,
        fixingChecks,
        failedChecks,
        item,
        list,
        setFixingChecks,
        setFixChecksComposerPrompt
      })
    },
    onRerun: (failedOnly) => {
      void handleRerun(failedOnly)
    }
  })

  const compactHeader = (
    <ChecksCompactHeader
      SummaryIcon={SummaryIcon}
      summaryColor={summaryColor}
      summaryLabel={summaryLabel}
      counts={counts}
      listLength={list.length}
      refreshAction={refreshAction}
      rerunAction={rerunAction}
      secondaryActions={secondaryActions}
    />
  )

  const fixChecksAgentDialog = (
    <ChecksFixDialog
      fixChecksComposerPrompt={fixChecksComposerPrompt}
      setFixChecksComposerPrompt={setFixChecksComposerPrompt}
      fixChecksRecipe={fixChecksRecipe}
      fixChecksLaunchPlatform={fixChecksLaunchPlatform}
      repoConnectionId={repo?.connectionId ?? null}
      targetRepoId={targetRepoId}
      item={item}
      updateSettings={updateSettings}
      updateRepo={updateRepo}
    />
  )

  const renderCheckRow = (check: PRCheckDetail): React.JSX.Element => {
    const key = getCheckDetailsKey(check)
    return (
      <CheckRow
        key={key}
        check={check}
        variant={variant}
        expanded={expandedCheckKey === key}
        detailsState={detailsByCheckKey[key]}
        onToggle={handleToggleCheckDetails}
        onRetryDetails={requestCheckDetails}
      />
    )
  }

  return (
    <ChecksTabLayouts
      loading={loading}
      listLength={list.length}
      variant={variant}
      compactHeader={compactHeader}
      actions={actions}
      SummaryIcon={SummaryIcon}
      summaryColor={summaryColor}
      summaryLabel={summaryLabel}
      counts={counts}
      sorted={sorted}
      renderCheckRow={renderCheckRow}
      fixChecksAgentDialog={fixChecksAgentDialog}
    />
  )
}
