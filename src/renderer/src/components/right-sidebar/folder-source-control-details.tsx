import React, { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import type {
  GitBranchCompareSummary,
  SourceControlViewMode,
  Worktree
} from '../../../../shared/types'
import { GitHistoryPanel } from './GitHistoryPanel'
import {
  CreateReviewBlockedNotice,
  FolderCommitArea,
  FolderSourceControlToolbar
} from './folder-source-control-actions'
import { FolderSourceControlBaseRefDialog } from './folder-source-control-base-ref-dialog'
import { FolderSourceControlCreateReviewDialog } from './folder-source-control-create-review-dialog'
import { groupStatusEntries } from './folder-source-control-inline-rows'
import { FolderSourceControlSections } from './folder-source-control-sections'
import { useFolderSourceControlCommitHistory } from './folder-source-control-commit-history'
import { useShowVisibleEditorTab } from './folder-source-control-editor-tabs'
import { useFolderSourceControlOpenActions } from './folder-source-control-open-actions'
import { SourceControlDiscardDialog } from './source-control-discard-dialog'
import { SourceControlBranchContextRow } from './source-control-branch-context-row'
import type { FolderGitTarget } from './folder-source-control-repos'
import type { RepoStatusState } from './folder-source-control-rows'
import { useFolderSourceControlData } from './use-folder-source-control-data'
import { useFolderSourceControlMutations } from './use-folder-source-control-mutations'

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
  const data = useFolderSourceControlData({
    target,
    worktree,
    statusState,
    settings,
    onBranchChanged
  })
  const mutations = useFolderSourceControlMutations({
    context: data.context,
    statusState,
    loadDetails: data.loadDetails,
    onBranchChanged
  })
  const diffWorktreeId = worktree?.id ?? `folder-git:${target.key}`
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const [filterQuery, setFilterQuery] = useState('')
  const [viewMode, setViewMode] = useState<SourceControlViewMode>('list')
  const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false)

  const { loadCommitFiles, openHistoryCommitDiff, openCommitFile } =
    useFolderSourceControlCommitHistory({
      context: data.context,
      diffWorktreeId,
      worktreePath: data.effectiveWorktreePath,
      onOpenVisibleFile: (fileId, label) => showVisibleEditorTab(fileId, 'diff', label)
    })

  const { openEntry, openBranchEntry, viewAllArea } = useFolderSourceControlOpenActions({
    diffWorktreeId,
    targetPath: data.effectiveWorktreePath,
    branchCompare: data.branchCompare.status === 'ready' ? data.branchCompare.result : null,
    showVisibleEditorTab,
    statusEntries: statusState?.status?.entries ?? []
  })

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
      return data.branchCompare.status === 'ready' ? data.branchCompare.result.entries : []
    }
    return data.branchCompare.status === 'ready'
      ? data.branchCompare.result.entries.filter((entry) =>
          entry.path.toLocaleLowerCase().includes(query)
        )
      : []
  }, [data.branchCompare, filterQuery])
  const currentBaseRef =
    data.baseRefOverride ??
    (data.branchCompare.status === 'ready' ? data.branchCompare.result.summary.baseRef : undefined)
  const headDisplay = useMemo(
    () => getWorktreeGitIdentityDisplay({ branch: data.status?.branch, head: data.status?.head }),
    [data.status?.branch, data.status?.head]
  )
  const branchCompareSummary = useMemo<GitBranchCompareSummary | null>(() => {
    if (data.branchCompare.status === 'ready') {
      return data.branchCompare.result.summary
    }
    if (data.branchCompare.status === 'error' && currentBaseRef) {
      return {
        baseRef: currentBaseRef,
        baseOid: null,
        compareRef: data.status?.branch ?? '',
        headOid: data.status?.head ?? null,
        mergeBase: null,
        changedFiles: 0,
        status: 'error',
        errorMessage: data.branchCompare.error
      }
    }
    return null
  }, [currentBaseRef, data.branchCompare, data.status?.branch, data.status?.head])

  return (
    <div className="border-b border-border pb-2">
      <FolderSourceControlToolbar
        branch={data.status?.branch}
        branches={data.branches}
        branchSwitching={data.branchSwitching}
        onSwitchBranch={(branch) => void data.switchBranch(branch)}
        onStageAll={mutations.stageAll}
        stageAllBusy={mutations.stageAllBusy}
        onCreatePr={mutations.handleCreatePrClick}
        filterQuery={filterQuery}
        onFilterQueryChange={setFilterQuery}
        viewMode={viewMode}
        onToggleViewMode={() => setViewMode((current) => (current === 'list' ? 'tree' : 'list'))}
        onChangeBaseRef={() => setBaseRefDialogOpen(true)}
        onRefreshBranchCompare={() => void data.loadDetails()}
        branchCompareRefreshing={data.branchCompare.status === 'loading'}
        reviewCopy={data.reviewCopy}
      />
      <SourceControlBranchContextRow
        summary={branchCompareSummary}
        compareBaseRef={currentBaseRef ?? null}
        headDisplay={headDisplay}
        upstreamStatus={data.status?.upstreamStatus ?? data.upstream ?? undefined}
        onChangeBaseRef={() => setBaseRefDialogOpen(true)}
        onRetry={() => void data.loadDetails()}
      />
      {data.branchSwitchError ? (
        <div className="mx-3 mb-1 text-[11px] text-destructive">{data.branchSwitchError}</div>
      ) : null}
      {mutations.operationError ? (
        <div className="mx-3 mb-1 text-[11px] text-destructive">{mutations.operationError}</div>
      ) : null}
      {mutations.createReviewBlocked && (statusState?.status?.entries.length ?? 0) > 0 ? (
        <CreateReviewBlockedNotice reviewLabel={data.reviewCopy.reviewLabel} />
      ) : null}

      <FolderCommitArea
        value={mutations.commitMessage}
        onChange={mutations.setCommitMessage}
        onCommit={() => void mutations.handleCommit()}
        busy={mutations.commitBusy}
        error={mutations.commitError}
      />

      <FolderSourceControlSections
        groupedEntries={filteredGroupedEntries}
        branchEntries={filteredBranchEntries}
        collapsedSections={collapsedSections}
        viewMode={viewMode}
        onToggleSection={toggleSection}
        onOpenEntry={openEntry}
        onOpenBranchEntry={openBranchEntry}
        onStageEntry={mutations.stageEntry}
        onUnstageEntry={mutations.unstageEntry}
        onDiscardEntry={mutations.discardEntry}
        onStageAll={mutations.stageAllArea}
        onUnstageAll={mutations.unstageAllArea}
        onDiscardAll={mutations.requestDiscardAll}
        onViewAll={viewAllArea}
      />

      <GitHistoryPanel
        state={data.history}
        collapsed={collapsedSections.has('history')}
        onToggle={() => toggleSection('history')}
        onRefresh={() => void data.loadDetails()}
        onLoadCommitFiles={loadCommitFiles}
        onOpenCommit={(item) => void openHistoryCommitDiff(item)}
        onOpenCommitFile={openCommitFile}
      />

      <FolderSourceControlBaseRefDialog
        open={baseRefDialogOpen}
        onOpenChange={setBaseRefDialogOpen}
        target={target}
        currentBaseRef={currentBaseRef}
        onSelect={(ref) => {
          data.setBaseRefOverride(ref)
          setBaseRefDialogOpen(false)
          void data.loadDetails()
        }}
        onUsePrimary={() => {
          data.setBaseRefOverride(null)
          setBaseRefDialogOpen(false)
          void data.loadDetails()
        }}
      />
      <FolderSourceControlCreateReviewDialog
        open={mutations.createReviewDialogOpen}
        onOpenChange={mutations.setCreateReviewDialogOpen}
        target={target}
        worktreePath={data.effectiveWorktreePath}
        branch={data.status?.branch}
        baseRef={currentBaseRef}
        upstream={data.status?.upstreamStatus ?? data.upstream}
        reviewCopy={data.reviewCopy}
        hasUncommittedChanges={(statusState?.status?.entries.length ?? 0) > 0}
        onCreated={() => {
          onBranchChanged?.()
          void data.loadDetails()
        }}
      />
      <SourceControlDiscardDialog
        pendingDiscard={mutations.pendingDiscard}
        onCancel={() => mutations.setPendingDiscard(null)}
        onConfirm={mutations.confirmPendingDiscard}
      />
    </div>
  )
}
