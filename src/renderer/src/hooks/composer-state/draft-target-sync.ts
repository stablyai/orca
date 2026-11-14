import { useEffect } from 'react'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ComposerModel } from './composer-model'
import { pickerRepos } from '../../../../shared/hidden-projects'

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
    // The default prefers Local among listed projects; a hidden one stays reachable only when named (#41140).
    const listedRepos = pickerRepos(eligibleRepos)
    if (!repoId) {
      const localRepo = listedRepos.find(
        (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
      const seedRepoId = localRepo?.id ?? listedRepos[0]?.id
      if (seedRepoId) {
        setRepoId(seedRepoId)
      }
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
