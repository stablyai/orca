import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { translate } from '@/i18n/i18n'
import {
  bulkStageRuntimeGitPaths,
  checkoutRuntimeGitBranch,
  commitRuntimeGit,
  discardRuntimeGitPath,
  getRuntimeGitBranchCompare,
  getRuntimeGitHistory,
  getRuntimeGitUpstreamStatus,
  listRuntimeGitLocalBranches,
  stageRuntimeGitPath,
  unstageRuntimeGitPath
} from '@/runtime/runtime-git-client'
import { getRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'
import type { RuntimeGitLocalBranches } from '../../../../shared/runtime-types'
import type {
  GitBranchCompareResult,
  GitStatusEntry,
  GitUpstreamStatus,
  SourceControlViewMode,
  Worktree
} from '../../../../shared/types'
import type { GitHistoryPanelState } from './GitHistoryPanel'
import { GitHistoryPanel } from './GitHistoryPanel'
import {
  CreateReviewBlockedNotice,
  FolderCommitArea,
  FolderSourceControlToolbar
} from './folder-source-control-actions'
import { FolderSourceControlBaseRefDialog } from './folder-source-control-base-ref-dialog'
import { groupStatusEntries } from './folder-source-control-inline-rows'
import { FolderSourceControlSections } from './folder-source-control-sections'
import { useFolderSourceControlCommitHistory } from './folder-source-control-commit-history'
import { useShowVisibleEditorTab } from './folder-source-control-editor-tabs'
import { useFolderSourceControlOpenActions } from './folder-source-control-open-actions'
import { useFolderSourceControlBulkActions } from './folder-source-control-bulk-actions'
import type { FolderGitTarget } from './folder-source-control-repos'
import type { RepoStatusState } from './folder-source-control-rows'

type BranchCompareState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; result: GitBranchCompareResult }
  | { status: 'error'; error: string }

export function FolderSourceControlDetails({
  target,
  worktree,
  statusState,
  settings,
  onBranchChanged
}: {
  target: FolderGitTarget
  worktree: Worktree | null
  statusState: RepoStatusState | undefined
  settings: ReturnType<typeof useAppStore.getState>['settings']
  onBranchChanged?: () => void
}): React.JSX.Element {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeEditorGroupId = useAppStore((state) =>
    state.activeWorktreeId
      ? (state.activeGroupIdByWorktree?.[state.activeWorktreeId] ??
        state.groupsByWorktree?.[state.activeWorktreeId]?.[0]?.id)
      : undefined
  )
  const showVisibleEditorTab = useShowVisibleEditorTab(activeWorktreeId, activeEditorGroupId)
  const diffWorktreeId = worktree?.id ?? `folder-git:${target.key}`
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const [branchCompare, setBranchCompare] = useState<BranchCompareState>({ status: 'idle' })
  const [history, setHistory] = useState<GitHistoryPanelState>({ status: 'idle' })
  const [upstream, setUpstream] = useState<GitUpstreamStatus | null>(null)
  const [branches, setBranches] = useState<RuntimeGitLocalBranches | null>(null)
  const [branchSwitching, setBranchSwitching] = useState(false)
  const [branchSwitchError, setBranchSwitchError] = useState<string | null>(null)
  const [stageAllBusy, setStageAllBusy] = useState(false)
  const [createReviewBlocked, setCreateReviewBlocked] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitBusy, setCommitBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const [viewMode, setViewMode] = useState<SourceControlViewMode>('list')
  const [baseRefOverride, setBaseRefOverride] = useState<string | null>(null)
  const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false)
  const status = statusState?.status
  const context = useMemo(
    () => ({
      settings: getRepoOwnerRoutedSettings(settings, {
        id: target.key,
        connectionId: target.connectionId,
        executionHostId: target.executionHostId
      }),
      worktreeId: worktree?.id ?? null,
      worktreePath: worktree?.path ?? target.path,
      connectionId: target.connectionId ?? undefined
    }),
    [settings, target, worktree?.id, worktree?.path]
  )

  const loadDetails = useCallback(async () => {
    setBranchCompare({ status: 'loading' })
    setHistory({ status: 'loading' })
    let baseRef = baseRefOverride || worktree?.baseRef || target.repo?.worktreeBaseRef || null
    if (!baseRef && target.repo) {
      const baseRefDefault = await getRuntimeRepoBaseRefDefault(
        context.settings,
        target.repo.id
      ).catch(() => null)
      baseRef = baseRefDefault?.defaultBaseRef ?? null
    }
    if (!baseRef) {
      baseRef = statusState?.status?.upstreamStatus?.upstreamName ?? upstream?.upstreamName ?? null
    }
    if (!baseRef) {
      const nextUpstream = await getRuntimeGitUpstreamStatus(context).catch(() => null)
      if (nextUpstream) {
        setUpstream(nextUpstream)
        baseRef = nextUpstream.upstreamName ?? null
      }
    }
    if (baseRef) {
      const result = await getRuntimeGitBranchCompare(context, baseRef).catch(() => null)
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
      setHistory({ status: 'ready', result: historyResult })
    } catch (error) {
      setHistory({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to load commits'
      })
    }
  }, [
    baseRefOverride,
    context,
    statusState?.status?.upstreamStatus?.upstreamName,
    target.repo,
    upstream?.upstreamName,
    worktree?.baseRef
  ])

  useEffect(() => {
    void loadDetails()
  }, [loadDetails])

  const loadBranches = useCallback(async () => {
    const result = await listRuntimeGitLocalBranches(context).catch(() => null)
    if (result) {
      setBranches(result)
    }
  }, [context])

  useEffect(() => {
    void loadBranches()
  }, [loadBranches])

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

  const stageAll = useCallback(async () => {
    const entries = statusState?.status?.entries ?? []
    const paths = entries.filter((entry) => entry.area !== 'staged').map((entry) => entry.path)
    if (paths.length === 0) {
      return
    }
    setStageAllBusy(true)
    try {
      await bulkStageRuntimeGitPaths(context, paths)
      onBranchChanged?.()
      await loadDetails()
    } finally {
      setStageAllBusy(false)
    }
  }, [context, loadDetails, onBranchChanged, statusState?.status?.entries])

  const { stageAllArea, unstageAllArea, discardAllArea } = useFolderSourceControlBulkActions({
    context,
    entries: statusState?.status?.entries ?? [],
    loadDetails,
    onBranchChanged
  })

  const stageEntry = useCallback(
    async (entry: GitStatusEntry) => {
      await stageRuntimeGitPath(context, entry.path)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, loadDetails, onBranchChanged]
  )

  const unstageEntry = useCallback(
    async (entry: GitStatusEntry) => {
      await unstageRuntimeGitPath(context, entry.path)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, loadDetails, onBranchChanged]
  )

  const discardEntry = useCallback(
    async (entry: GitStatusEntry) => {
      await discardRuntimeGitPath(context, entry.path)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, loadDetails, onBranchChanged]
  )

  const handleCommit = useCallback(async () => {
    const message = commitMessage.trim()
    if (!message || commitBusy) {
      return
    }
    setCommitBusy(true)
    setCommitError(null)
    try {
      const result = await commitRuntimeGit(context, message)
      if (!result.success) {
        setCommitError(result.error ?? 'Commit failed')
        return
      }
      setCommitMessage('')
      onBranchChanged?.()
      await loadDetails()
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error))
    } finally {
      setCommitBusy(false)
    }
  }, [commitBusy, commitMessage, context, loadDetails, onBranchChanged])

  const handleCreatePrClick = useCallback(() => {
    setCreateReviewBlocked((statusState?.status?.entries.length ?? 0) > 0)
  }, [statusState?.status?.entries.length])

  const toggleSection = useCallback((id: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const { loadCommitFiles, openHistoryCommitDiff, openCommitFile } =
    useFolderSourceControlCommitHistory({
      context,
      diffWorktreeId,
      worktreePath: target.path,
      onOpenVisibleFile: (fileId, label) => showVisibleEditorTab(fileId, 'diff', label)
    })

  const { openEntry, openBranchEntry, viewAllArea } = useFolderSourceControlOpenActions({
    diffWorktreeId,
    targetPath: target.path,
    branchCompare: branchCompare.status === 'ready' ? branchCompare.result : null,
    showVisibleEditorTab,
    statusEntries: statusState?.status?.entries ?? []
  })

  const groupedEntries = useMemo(
    () => groupStatusEntries(statusState?.status?.entries ?? []),
    [statusState?.status?.entries]
  )
  const filteredGroupedEntries = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase()
    if (!query) {
      return groupedEntries
    }
    return {
      staged: groupedEntries.staged.filter((entry) =>
        entry.path.toLocaleLowerCase().includes(query)
      ),
      unstaged: groupedEntries.unstaged.filter((entry) =>
        entry.path.toLocaleLowerCase().includes(query)
      ),
      untracked: groupedEntries.untracked.filter((entry) =>
        entry.path.toLocaleLowerCase().includes(query)
      )
    }
  }, [filterQuery, groupedEntries])
  const filteredBranchEntries = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase()
    if (!query) {
      return branchCompare.status === 'ready' ? branchCompare.result.entries : []
    }
    return branchCompare.status === 'ready'
      ? branchCompare.result.entries.filter((entry) =>
          entry.path.toLocaleLowerCase().includes(query)
        )
      : []
  }, [branchCompare, filterQuery])

  return (
    <div className="border-b border-border pb-2">
      <FolderSourceControlToolbar
        branch={status?.branch}
        branches={branches}
        branchSwitching={branchSwitching}
        onSwitchBranch={(branch) => void switchBranch(branch)}
        upstreamName={
          status?.upstreamStatus?.hasUpstream ? status.upstreamStatus.upstreamName : null
        }
        onStageAll={() => void stageAll()}
        stageAllBusy={stageAllBusy}
        onCreatePr={handleCreatePrClick}
        filterQuery={filterQuery}
        onFilterQueryChange={setFilterQuery}
        viewMode={viewMode}
        onToggleViewMode={() => setViewMode((current) => (current === 'list' ? 'tree' : 'list'))}
        onChangeBaseRef={() => setBaseRefDialogOpen(true)}
        onRefreshBranchCompare={() => void loadDetails()}
        branchCompareReady={branchCompare.status === 'ready'}
      />
      {branchSwitchError ? (
        <div className="mx-3 mb-1 text-[11px] text-destructive">{branchSwitchError}</div>
      ) : null}
      {createReviewBlocked ? <CreateReviewBlockedNotice /> : null}

      <FolderCommitArea
        value={commitMessage}
        onChange={setCommitMessage}
        onCommit={() => void handleCommit()}
        busy={commitBusy}
        error={commitError}
      />

      <FolderSourceControlSections
        groupedEntries={filteredGroupedEntries}
        branchEntries={filteredBranchEntries}
        collapsedSections={collapsedSections}
        viewMode={viewMode}
        onToggleSection={toggleSection}
        onOpenEntry={openEntry}
        onOpenBranchEntry={openBranchEntry}
        onStageEntry={(entry) => void stageEntry(entry)}
        onUnstageEntry={(entry) => void unstageEntry(entry)}
        onDiscardEntry={(entry) => void discardEntry(entry)}
        onStageAll={(area) => void stageAllArea(area)}
        onUnstageAll={(area) => void unstageAllArea(area)}
        onDiscardAll={(area) => void discardAllArea(area)}
        onViewAll={(area) => viewAllArea(area)}
      />

      <GitHistoryPanel
        state={history}
        collapsed={collapsedSections.has('history')}
        onToggle={() => toggleSection('history')}
        onRefresh={() => void loadDetails()}
        onLoadCommitFiles={loadCommitFiles}
        onOpenCommit={(item) => void openHistoryCommitDiff(item)}
        onOpenCommitFile={openCommitFile}
      />

      <FolderSourceControlBaseRefDialog
        open={baseRefDialogOpen}
        onOpenChange={setBaseRefDialogOpen}
        target={target}
        currentBaseRef={
          baseRefOverride ??
          (branchCompare.status === 'ready' ? branchCompare.result.summary.baseRef : undefined)
        }
        onSelect={(ref) => {
          setBaseRefOverride(ref)
          setBaseRefDialogOpen(false)
          void loadDetails()
        }}
        onUsePrimary={() => {
          setBaseRefOverride(null)
          setBaseRefDialogOpen(false)
          void loadDetails()
        }}
      />
    </div>
  )
}
