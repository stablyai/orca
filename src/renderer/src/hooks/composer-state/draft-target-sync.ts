import { useEffect } from 'react'
import type { ComposerModel } from './composer-model'

export type DraftTargetSyncInput = Pick<
  ComposerModel,
  | 'agentPrompt'
  | 'attachmentPaths'
  | 'baseBranch'
  | 'baseBranchNamesWorkspace'
  | 'compareBaseRef'
  | 'eligibleRepos'
  | 'fetchSparsePresets'
  | 'folderSourceRepos'
  | 'isProjectGroupTarget'
  | 'linkedGitLabIssue'
  | 'linkedGitLabMR'
  | 'linkedIssue'
  | 'linkedPR'
  | 'linkedWorkItem'
  | 'name'
  | 'note'
  | 'persistDraft'
  | 'pendingInitialWorkspaceTarget'
  | 'repoId'
  | 'selectedProjectGroup'
  | 'selectedRepo'
  | 'selectedRepoIsGit'
  | 'selectedWorkspaceTarget'
  | 'setNewWorkspaceDraft'
  | 'setRepoId'
  | 'sparsePresetsByRepo'
  | 'taskSourceContext'
  | 'tuiAgent'
>

export function useDraftTargetSync(state: DraftTargetSyncInput): void {
  const {
    agentPrompt,
    attachmentPaths,
    baseBranch,
    baseBranchNamesWorkspace,
    compareBaseRef,
    eligibleRepos,
    fetchSparsePresets,
    folderSourceRepos,
    isProjectGroupTarget,
    linkedGitLabIssue,
    linkedGitLabMR,
    linkedIssue,
    linkedPR,
    linkedWorkItem,
    name,
    note,
    persistDraft,
    pendingInitialWorkspaceTarget,
    repoId,
    selectedProjectGroup,
    selectedRepo,
    selectedRepoIsGit,
    selectedWorkspaceTarget,
    setNewWorkspaceDraft,
    setRepoId,
    sparsePresetsByRepo,
    taskSourceContext,
    tuiAgent
  } = state

  useEffect(() => {
    if (!persistDraft) {
      return
    }
    setNewWorkspaceDraft({
      repoId: repoId || null,
      projectId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.projectId
            : null,
      projectGroupId: selectedProjectGroup?.id ?? null,
      hostId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.hostId
            : null,
      projectHostSetupId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.projectHostSetupId
            : null,
      name,
      prompt: agentPrompt,
      note,
      attachments: attachmentPaths,
      linkedWorkItem,
      linkedTaskSourceContext: taskSourceContext,
      agent: tuiAgent,
      linkedIssue,
      linkedPR,
      linkedGitLabIssue,
      linkedGitLabMR,
      ...(baseBranch !== undefined ? { baseBranch, baseBranchNamesWorkspace } : {}),
      ...(compareBaseRef !== undefined ? { compareBaseRef } : {})
    })
  }, [
    persistDraft,
    agentPrompt,
    attachmentPaths,
    baseBranch,
    baseBranchNamesWorkspace,
    compareBaseRef,
    linkedIssue,
    linkedPR,
    linkedGitLabIssue,
    linkedGitLabMR,
    linkedWorkItem,
    note,
    name,
    repoId,
    selectedProjectGroup,
    selectedWorkspaceTarget,
    setNewWorkspaceDraft,
    taskSourceContext,
    tuiAgent
  ])

  useEffect(() => {
    if (isProjectGroupTarget || pendingInitialWorkspaceTarget) {
      return
    }
    if (!repoId && eligibleRepos[0]?.id) {
      setRepoId(eligibleRepos[0].id)
    }
  }, [eligibleRepos, isProjectGroupTarget, pendingInitialWorkspaceTarget, repoId, setRepoId])

  useEffect(() => {
    if (!selectedProjectGroup) {
      return
    }
    if (repoId && folderSourceRepos.some((repo) => repo.id === repoId)) {
      return
    }
    setRepoId(folderSourceRepos[0]?.id ?? '')
  }, [folderSourceRepos, repoId, selectedProjectGroup, setRepoId])

  // Load presets before sparse mode: its Advanced dropdown is always visible.
  useEffect(() => {
    if (!repoId || !selectedRepoIsGit || selectedRepo?.connectionId) {
      return
    }
    if (sparsePresetsByRepo[repoId] !== undefined) {
      return
    }
    void fetchSparsePresets(repoId)
  }, [
    fetchSparsePresets,
    repoId,
    selectedRepo?.connectionId,
    selectedRepoIsGit,
    sparsePresetsByRepo
  ])
}
