import type * as React from 'react'
import type { RefObject } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
import type { WorkspaceCreationTargetResolution } from '@/lib/project-host-workspace-target'

export type ComposerInitialTargetModel = {
  draftRepoId: string | null
  draftProjectId: string | null
  draftProjectGroupId: string | null
  draftHostId: ExecutionHostId | null
  draftProjectHostSetupId: string | null
  initialRunSeed: {
    projectId: string | null
    hostId: ExecutionHostId | null
    projectHostSetupId: string | null
  }
  pendingInitialWorkspaceTarget: ComposerInitialTargetModel['initialRunSeed'] | null
  setPendingInitialWorkspaceTarget: React.Dispatch<
    React.SetStateAction<ComposerInitialTargetModel['initialRunSeed'] | null>
  >
  resolvedInitialWorkspaceStatus: WorkspaceStatus | undefined
  resolvedInitialWorkspaceTarget: WorkspaceCreationTargetResolution
  resolvedInitialRepoId: string
  internalRepoId: string
  setInternalRepoId: React.Dispatch<React.SetStateAction<string>>
  selectedProjectHostSetupOverrideId: string | null
  setSelectedProjectHostSetupOverrideId: React.Dispatch<React.SetStateAction<string | null>>
  selectedProjectHostSetupOverrideHostId: ExecutionHostId | null
  setSelectedProjectHostSetupOverrideHostId: React.Dispatch<
    React.SetStateAction<ExecutionHostId | null>
  >
  initialFolderProjectGroupId: string | null
  initialFolderProjectGroup: ProjectGroup | null
  selectedProjectGroupId: string | null
  setSelectedProjectGroupId: React.Dispatch<React.SetStateAction<string | null>>
  initialProjectGroupAppliedRef: RefObject<boolean>
  projectError: string | null
  setProjectError: React.Dispatch<React.SetStateAction<string | null>>
  repoId: string
  selectedProjectGroup: ProjectGroup | null
}
