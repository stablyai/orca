import type { ComposerModel } from './composer-model'

type ComposerInitialTargetStateInput = Pick<
  ComposerModel,
  | 'actionableHostIds'
  | 'eligibleRepos'
  | 'decisions'
  | 'initialProjectGroupId'
  | 'initialRepoId'
  | 'initialTaskSourceContext'
  | 'initialWorkspaceStatus'
  | 'newWorkspaceDraft'
  | 'persistDraft'
  | 'projectGroups'
  | 'projectHostSetups'
  | 'projects'
  | 'repoIdOverride'
  | 'seedActiveRepoId'
  | 'workspaceHostScope'
  | 'workspaceStatuses'
>

import { useEffect, useMemo, useRef, useState } from 'react'
import { isWorkspaceStatusId } from '../../../../shared/workspace-statuses'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { findActionableFolderProjectGroup } from '@/lib/new-workspace-project-options'
import type { ProjectGroup } from '../../../../shared/project-group-types'

export function useComposerInitialTargetState(input: ComposerInitialTargetStateInput) {
  const {
    actionableHostIds,
    decisions,
    eligibleRepos,
    initialProjectGroupId,
    initialRepoId,
    initialTaskSourceContext,
    initialWorkspaceStatus,
    newWorkspaceDraft,
    persistDraft,
    projectGroups,
    projectHostSetups,
    projects,
    repoIdOverride,
    seedActiveRepoId,
    workspaceHostScope,
    workspaceStatuses
  } = input
  const { resolveInitialWorkspaceRunSeed } = decisions

  const draftRepoId = persistDraft ? (newWorkspaceDraft?.repoId ?? null) : null

  const draftProjectId = persistDraft ? (newWorkspaceDraft?.projectId ?? null) : null

  const draftProjectGroupId = persistDraft ? (newWorkspaceDraft?.projectGroupId ?? null) : null

  const draftHostId = persistDraft ? (newWorkspaceDraft?.hostId ?? null) : null

  const draftProjectHostSetupId = persistDraft
    ? (newWorkspaceDraft?.projectHostSetupId ?? null)
    : null

  const initialRunSeed = resolveInitialWorkspaceRunSeed({
    draftProjectId,
    draftHostId,
    draftProjectHostSetupId,
    initialTaskSourceContext
  })

  const resolvedInitialWorkspaceStatus = useMemo(
    () =>
      initialWorkspaceStatus && isWorkspaceStatusId(initialWorkspaceStatus, workspaceStatuses)
        ? initialWorkspaceStatus
        : undefined,
    [initialWorkspaceStatus, workspaceStatuses]
  )

  const resolvedInitialWorkspaceTarget = resolveWorkspaceCreationTarget({
    eligibleRepos,
    projects,
    projectHostSetups,
    draftRepoId,
    initialRepoId,
    activeRepoId: seedActiveRepoId,
    projectId: initialRunSeed.projectId,
    hostId: initialRunSeed.hostId,
    projectHostSetupId: initialRunSeed.projectHostSetupId,
    focusedHostScope: workspaceHostScope,
    actionableHostIds
  })

  const resolvedInitialRepoId =
    resolvedInitialWorkspaceTarget.status === 'ready'
      ? resolvedInitialWorkspaceTarget.target.repoId
      : ''

  const [internalRepoId, setInternalRepoId] = useState<string>(resolvedInitialRepoId)

  const [selectedProjectHostSetupOverrideId, setSelectedProjectHostSetupOverrideId] = useState<
    string | null
  >(
    resolvedInitialWorkspaceTarget.status === 'ready'
      ? resolvedInitialWorkspaceTarget.target.projectHostSetupId
      : null
  )

  const initialFolderProjectGroupId = initialProjectGroupId ?? draftProjectGroupId

  const initialFolderProjectGroup = findActionableFolderProjectGroup({
    projectGroups,
    groupId: initialFolderProjectGroupId,
    actionableHostIds
  })

  const [selectedProjectGroupId, setSelectedProjectGroupId] = useState<string | null>(
    initialFolderProjectGroup?.id ?? null
  )

  const initialProjectGroupAppliedRef = useRef(Boolean(initialFolderProjectGroup))

  const [projectError, setProjectError] = useState<string | null>(null)

  const repoId = repoIdOverride ?? internalRepoId

  const selectedProjectGroup = useMemo<ProjectGroup | null>(
    () =>
      findActionableFolderProjectGroup({
        projectGroups,
        groupId: selectedProjectGroupId,
        actionableHostIds
      }),
    [actionableHostIds, projectGroups, selectedProjectGroupId]
  )

  useEffect(() => {
    if (selectedProjectGroupId && !selectedProjectGroup) {
      setSelectedProjectGroupId(null)
    }
  }, [selectedProjectGroup, selectedProjectGroupId])

  useEffect(() => {
    if (
      selectedProjectGroupId ||
      !initialFolderProjectGroupId ||
      initialProjectGroupAppliedRef.current
    ) {
      return
    }
    const nextGroup = findActionableFolderProjectGroup({
      projectGroups,
      groupId: initialFolderProjectGroupId,
      actionableHostIds
    })
    if (nextGroup) {
      initialProjectGroupAppliedRef.current = true
      setSelectedProjectGroupId(nextGroup.id)
    }
  }, [actionableHostIds, initialFolderProjectGroupId, projectGroups, selectedProjectGroupId])

  return {
    draftRepoId,
    draftProjectId,
    draftProjectGroupId,
    draftHostId,
    draftProjectHostSetupId,
    initialRunSeed,
    resolvedInitialWorkspaceStatus,
    resolvedInitialWorkspaceTarget,
    resolvedInitialRepoId,
    internalRepoId,
    setInternalRepoId,
    selectedProjectHostSetupOverrideId,
    setSelectedProjectHostSetupOverrideId,
    initialFolderProjectGroupId,
    initialFolderProjectGroup,
    selectedProjectGroupId,
    setSelectedProjectGroupId,
    initialProjectGroupAppliedRef,
    projectError,
    setProjectError,
    repoId,
    selectedProjectGroup
  }
}
