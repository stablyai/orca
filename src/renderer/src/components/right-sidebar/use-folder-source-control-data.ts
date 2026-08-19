import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState } from '@/store'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import {
  checkoutRuntimeGitBranch,
  getRuntimeGitBranchCompare,
  getRuntimeGitHistory,
  getRuntimeGitUpstreamStatus,
  listRuntimeGitLocalBranches,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { getRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'
import type { RuntimeGitLocalBranches } from '../../../../shared/runtime-types'
import type {
  GitBranchCompareResult,
  GitStatusResult,
  GitUpstreamStatus,
  Worktree
} from '../../../../shared/types'
import type { GitHistoryPanelState } from './GitHistoryPanel'
import type { FolderGitTarget } from './folder-source-control-repos'
import type { RepoStatusState } from './folder-source-control-rows'
import { parseRemoteRepo } from './source-control-remote-repo'

export type BranchCompareState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; result: GitBranchCompareResult }
  | { status: 'error'; error: string }

/** Loads status-adjacent data and branch actions for one folder git target. */
export function useFolderSourceControlData({
  target,
  worktree,
  statusState,
  settings,
  onBranchChanged
}: {
  target: FolderGitTarget
  worktree: Worktree | null
  statusState: RepoStatusState | undefined
  settings: AppState['settings']
  onBranchChanged?: () => void
}): {
  status: GitStatusResult | null | undefined
  context: RuntimeGitContext
  effectiveWorktreePath: string
  reviewCopy: ReturnType<typeof localizedHostedReviewCopy>
  branchCompare: BranchCompareState
  baseRefOverride: string | null
  setBaseRefOverride: (value: string | null) => void
  history: GitHistoryPanelState
  upstream: GitUpstreamStatus | null
  branches: RuntimeGitLocalBranches | null
  branchSwitching: boolean
  branchSwitchError: string | null
  switchBranch: (branch: string) => Promise<void>
  loadDetails: () => Promise<void>
  loadBranches: () => Promise<void>
} {
  const [branchCompare, setBranchCompare] = useState<BranchCompareState>({ status: 'idle' })
  const [history, setHistory] = useState<GitHistoryPanelState>({ status: 'idle' })
  const [upstream, setUpstream] = useState<GitUpstreamStatus | null>(null)
  const [branches, setBranches] = useState<RuntimeGitLocalBranches | null>(null)
  const [branchSwitching, setBranchSwitching] = useState(false)
  const [branchSwitchError, setBranchSwitchError] = useState<string | null>(null)
  const [baseRefOverride, setBaseRefOverride] = useState<string | null>(null)
  const loadRunRef = useRef(0)
  const upstreamNameRef = useRef(upstream?.upstreamName)
  upstreamNameRef.current = upstream?.upstreamName
  const status = statusState?.status
  const effectiveWorktreePath = worktree?.path ?? target.path
  const context = useMemo(
    () => ({
      settings: getRepoOwnerRoutedSettings(settings, {
        id: target.key,
        connectionId: target.connectionId,
        executionHostId: target.executionHostId
      }),
      worktreeId: worktree?.id ?? null,
      worktreePath: effectiveWorktreePath,
      connectionId: target.connectionId ?? undefined
    }),
    [effectiveWorktreePath, settings, target, worktree?.id]
  )
  const reviewCopy = useMemo(
    () =>
      localizedHostedReviewCopy(
        resolveSupportedHostedReviewCopyProvider(
          parseRemoteRepo(target.repo?.gitRemoteIdentity?.remoteUrl ?? '')?.provider ?? null
        )
      ),
    [target.repo?.gitRemoteIdentity?.remoteUrl]
  )

  /** Loads branch compare, history, and upstream data for the target. */
  const loadDetails = useCallback(async () => {
    const runId = ++loadRunRef.current
    /** Guards state writes to the latest load cycle. */
    function isCurrent(): boolean {
      return loadRunRef.current === runId
    }
    setBranchCompare({ status: 'loading' })
    setHistory({ status: 'loading' })
    let baseRef = baseRefOverride || worktree?.baseRef || target.repo?.worktreeBaseRef || null
    if (!baseRef && target.repo) {
      const baseRefDefault = await getRuntimeRepoBaseRefDefault(
        context.settings,
        target.repo.id
      ).catch(() => null)
      if (!isCurrent()) {
        return
      }
      baseRef = baseRefDefault?.defaultBaseRef ?? null
    }
    if (!baseRef) {
      baseRef = statusState?.status?.upstreamStatus?.upstreamName ?? upstreamNameRef.current ?? null
    }
    if (!baseRef) {
      const nextUpstream = await getRuntimeGitUpstreamStatus(context).catch(() => null)
      if (!isCurrent()) {
        return
      }
      if (nextUpstream) {
        setUpstream(nextUpstream)
        baseRef = nextUpstream.upstreamName ?? null
      }
    }
    if (baseRef) {
      const result = await getRuntimeGitBranchCompare(context, baseRef).catch(() => null)
      if (!isCurrent()) {
        return
      }
      if (result) {
        setBranchCompare({ status: 'ready', result })
      } else {
        setBranchCompare({
          status: 'error',
          error: translate(
            'auto.components.right.sidebar.SourceControl.97d8b03cdf',
            'Branch compare failed'
          )
        })
      }
    } else {
      setBranchCompare({ status: 'idle' })
    }
    try {
      const historyResult = await getRuntimeGitHistory(context, {
        limit: 50,
        ...(baseRef ? { baseRef } : {})
      })
      if (isCurrent()) {
        setHistory({ status: 'ready', result: historyResult })
      }
    } catch (error) {
      if (isCurrent()) {
        setHistory({
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.right.sidebar.use.folder.source.control.data.8734e34338',
                  'Failed to load commits'
                )
        })
      }
    }
  }, [
    baseRefOverride,
    context,
    statusState?.status?.upstreamStatus?.upstreamName,
    target.repo,
    worktree?.baseRef
  ])

  useEffect(() => {
    void loadDetails()
  }, [loadDetails])

  /** Loads the target's local branch list. */
  const loadBranches = useCallback(async () => {
    const result = await listRuntimeGitLocalBranches(context).catch(() => null)
    if (result) {
      setBranches(result)
    }
  }, [context])

  useEffect(() => {
    void loadBranches()
  }, [loadBranches])

  /** Checks out a branch and refreshes target data. */
  const switchBranch = useCallback(
    async (branch: string) => {
      if (!branch || branch === status?.branch) {
        return
      }
      setBranchSwitching(true)
      setBranchSwitchError(null)
      try {
        await checkoutRuntimeGitBranch(context, branch)
        onBranchChanged?.()
        await loadDetails()
        await loadBranches()
      } catch (error) {
        setBranchSwitchError(error instanceof Error ? error.message : String(error))
      } finally {
        setBranchSwitching(false)
      }
    },
    [context, loadBranches, loadDetails, onBranchChanged, status?.branch]
  )

  return {
    status,
    context,
    effectiveWorktreePath,
    reviewCopy,
    branchCompare,
    baseRefOverride,
    setBaseRefOverride,
    history,
    upstream,
    branches,
    branchSwitching,
    branchSwitchError,
    switchBranch,
    loadDetails,
    loadBranches
  }
}
