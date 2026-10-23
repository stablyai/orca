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

  const firstChoiceHostId =
    selectedWorkspaceTarget.status === 'ambiguous'
      ? selectedWorkspaceTarget.candidates[0]?.hostId
      : null
  const ambiguousChoiceHostId =
    selectedWorkspaceTarget.status === 'ambiguous' &&
    selectedWorkspaceTarget.candidates.every((candidate) => candidate.hostId === firstChoiceHostId)
      ? (firstChoiceHostId ?? null)
      : null

  // Persist draft whenever relevant fields change (full-page only).
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
            : selectedWorkspaceTarget.status === 'ambiguous'
              ? selectedWorkspaceTarget.projectId
              : null,
      projectGroupId: selectedProjectGroup?.id ?? null,
      hostId:
        selectedProjectGroup !== null
          ? null
          : selectedWorkspaceTarget.status === 'ready'
            ? selectedWorkspaceTarget.target.hostId
            : ambiguousChoiceHostId,
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
    ambiguousChoiceHostId,
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

  // Auto-pick the first eligible repo if we somehow start with none selected.
  useEffect(() => {
    if (
      isProjectGroupTarget ||
      pendingInitialWorkspaceTarget ||
      selectedWorkspaceTarget.status === 'ambiguous'
    ) {
      return
    }
    if (!repoId && eligibleRepos[0]?.id) {
      setRepoId(eligibleRepos[0].id)
    }
  }, [
    eligibleRepos,
    isProjectGroupTarget,
    pendingInitialWorkspaceTarget,
    repoId,
    selectedWorkspaceTarget.status,
    setRepoId
  ])

  useEffect(() => {
    if (!selectedProjectGroup) {
      return
    }
    if (repoId && folderSourceRepos.some((repo) => repo.id === repoId)) {
      return
    }
    setRepoId(folderSourceRepos[0]?.id ?? '')
  }, [folderSourceRepos, repoId, selectedProjectGroup, setRepoId])

  // Why: the sparse dropdown is always visible under Advanced, so presets must load before sparse mode is enabled.
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
