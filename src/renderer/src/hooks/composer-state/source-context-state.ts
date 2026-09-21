import type { ComposerModel } from './composer-model'

type ComposerSourceContextStateInput = Pick<
  ComposerModel,
  | 'folderSourceRepos'
  | 'decisions'
  | 'initialLinkedWorkItem'
  | 'initialName'
  | 'initialPrompt'
  | 'initialTaskSourceContext'
  | 'isProjectGroupTarget'
  | 'newWorkspaceDraft'
  | 'persistDraft'
  | 'onRepoIdOverrideChange'
  | 'projects'
  | 'repoId'
  | 'selectedProjectGroup'
  | 'selectedProjectHostSetupId'
  | 'selectedProjectId'
  | 'selectedRepo'
  | 'selectedRepoIsGit'
  | 'setInternalRepoId'
  | 'selectedWorkspaceTarget'
>

import { useCallback, useMemo, useState } from 'react'
import { getLinkedWorkItemProvider, type LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getLinearLinkedWorkItemBranchName } from '@/lib/linear-linked-work-item'
import {
  type TaskSourceContext,
  buildTaskSourceContextFromRepo,
  normalizeTaskSourceContext
} from '../../../../shared/task-source-context'
import { resolveJiraSourceHostId } from '@/lib/jira-source-host'
import {
  normalizeGitHubLinkedWorkItem,
  getGitHubLinkedWorkItemIdentity
} from './source-selection-decisions'

export function useComposerSourceContextState(input: ComposerSourceContextStateInput) {
  const {
    folderSourceRepos,
    decisions,
    initialLinkedWorkItem,
    initialName,
    initialPrompt,
    initialTaskSourceContext,
    isProjectGroupTarget,
    newWorkspaceDraft,
    persistDraft,
    onRepoIdOverrideChange,
    projects,
    repoId,
    selectedProjectGroup,
    selectedProjectHostSetupId,
    selectedProjectId,
    selectedRepo,
    selectedRepoIsGit,
    setInternalRepoId,
    selectedWorkspaceTarget
  } = input
  const { getMatchingLinkedTaskSourceContext } = decisions
  const setRepoId = useCallback(
    (value: string) => {
      if (onRepoIdOverrideChange) {
        onRepoIdOverrideChange(value)
      } else {
        setInternalRepoId(value)
      }
    },
    [onRepoIdOverrideChange, setInternalRepoId]
  )

  const [name, setName] = useState<string>(
    persistDraft ? (newWorkspaceDraft?.name ?? initialName) : initialName
  )

  const [agentPrompt, setAgentPrompt] = useState<string>(
    persistDraft ? (newWorkspaceDraft?.prompt ?? initialPrompt) : initialPrompt
  )

  const [note, setNote] = useState<string>(persistDraft ? (newWorkspaceDraft?.note ?? '') : '')

  const [attachmentPaths, setAttachmentPaths] = useState<string[]>(
    persistDraft ? (newWorkspaceDraft?.attachments ?? []) : []
  )

  const normalizedInitialLinkedWorkItem = normalizeGitHubLinkedWorkItem(initialLinkedWorkItem)

  const normalizedDraftLinkedWorkItem = persistDraft
    ? normalizeGitHubLinkedWorkItem(newWorkspaceDraft?.linkedWorkItem)
    : null

  const draftLinkedTaskSourceContext = persistDraft
    ? getMatchingLinkedTaskSourceContext(
        normalizedDraftLinkedWorkItem,
        newWorkspaceDraft?.linkedTaskSourceContext ?? newWorkspaceDraft?.taskSourceContext
      )
    : null

  const initialLinkedTaskSourceContext = getMatchingLinkedTaskSourceContext(
    normalizedInitialLinkedWorkItem,
    initialTaskSourceContext
  )

  const initialLinkedWorkItemSeed =
    normalizedInitialLinkedWorkItem &&
    getLinkedWorkItemProvider(normalizedInitialLinkedWorkItem) === 'jira' &&
    !initialLinkedTaskSourceContext
      ? null
      : normalizedInitialLinkedWorkItem

  const draftLinkedWorkItemSeed =
    normalizedDraftLinkedWorkItem &&
    getLinkedWorkItemProvider(normalizedDraftLinkedWorkItem) === 'jira' &&
    !draftLinkedTaskSourceContext
      ? null
      : normalizedDraftLinkedWorkItem

  const linkedWorkItemSeed = persistDraft
    ? (draftLinkedWorkItemSeed ?? initialLinkedWorkItemSeed)
    : initialLinkedWorkItemSeed

  const linkedWorkItemSeedIdentity = getGitHubLinkedWorkItemIdentity(linkedWorkItemSeed)

  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(
    () => linkedWorkItemSeed
  )

  const initialLinearBranchName = getLinearLinkedWorkItemBranchName(linkedWorkItemSeed)

  const [linkedTaskSourceContext, setLinkedTaskSourceContext] = useState<TaskSourceContext | null>(
    () => draftLinkedTaskSourceContext ?? initialLinkedTaskSourceContext
  )

  const derivedGitHubTaskSourceContext = useMemo(() => {
    if (
      !linkedWorkItem ||
      getLinkedWorkItemProvider(linkedWorkItem) !== 'github' ||
      !selectedRepo ||
      selectedWorkspaceTarget.status !== 'ready'
    ) {
      return null
    }
    const selectedProject = projects.find(
      (project) => project.id === selectedWorkspaceTarget.target.projectId
    )
    if (selectedProject?.providerIdentity?.provider !== 'github') {
      return null
    }
    return buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: selectedWorkspaceTarget.target.projectId,
      repo: selectedRepo,
      projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
      providerIdentity: selectedProject.providerIdentity
    })
  }, [linkedWorkItem, projects, selectedRepo, selectedWorkspaceTarget])

  const taskSourceContext = linkedTaskSourceContext ?? derivedGitHubTaskSourceContext

  const selectedRepoGitHubSourceContext = useMemo(() => {
    if (!selectedRepo || !selectedRepoIsGit) {
      return null
    }
    if (taskSourceContext?.provider === 'github') {
      return taskSourceContext
    }
    if (selectedWorkspaceTarget.status === 'ready') {
      const selectedProject = projects.find(
        (project) => project.id === selectedWorkspaceTarget.target.projectId
      )
      return buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: selectedWorkspaceTarget.target.projectId,
        repo: selectedRepo,
        projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
        providerIdentity:
          selectedProject?.providerIdentity?.provider === 'github'
            ? selectedProject.providerIdentity
            : null
      })
    }
    return buildTaskSourceContextFromRepo({
      provider: 'github',
      projectId: selectedRepo.id,
      repo: selectedRepo
    })
  }, [projects, selectedRepo, selectedRepoIsGit, selectedWorkspaceTarget, taskSourceContext])

  const smartNameJiraSourceContext = useMemo(() => {
    if (!selectedProjectId) {
      return null
    }
    const sourceRepo = isProjectGroupTarget
      ? (folderSourceRepos.find((repo) => repo.id === repoId) ?? null)
      : selectedRepo
    return normalizeTaskSourceContext({
      provider: 'jira',
      projectId: selectedProjectGroup?.id ?? selectedProjectId,
      hostId: resolveJiraSourceHostId({
        workspaceHostId:
          selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.hostId : null,
        groupExecutionHostId: selectedProjectGroup?.executionHostId,
        groupConnectionId: selectedProjectGroup?.connectionId
      }),
      projectHostSetupId: selectedProjectGroup ? null : selectedProjectHostSetupId,
      repoId: sourceRepo?.id ?? null,
      providerIdentity: null,
      accountLabel: null
    })
  }, [
    folderSourceRepos,
    isProjectGroupTarget,
    repoId,
    selectedProjectGroup,
    selectedProjectHostSetupId,
    selectedProjectId,
    selectedRepo,
    selectedWorkspaceTarget
  ])

  return {
    setRepoId,
    name,
    setName,
    agentPrompt,
    setAgentPrompt,
    note,
    setNote,
    attachmentPaths,
    setAttachmentPaths,
    normalizedInitialLinkedWorkItem,
    normalizedDraftLinkedWorkItem,
    draftLinkedTaskSourceContext,
    initialLinkedTaskSourceContext,
    initialLinkedWorkItemSeed,
    draftLinkedWorkItemSeed,
    linkedWorkItemSeed,
    linkedWorkItemSeedIdentity,
    linkedWorkItem,
    setLinkedWorkItem,
    initialLinearBranchName,
    linkedTaskSourceContext,
    setLinkedTaskSourceContext,
    derivedGitHubTaskSourceContext,
    taskSourceContext,
    selectedRepoGitHubSourceContext,
    smartNameJiraSourceContext
  }
}
