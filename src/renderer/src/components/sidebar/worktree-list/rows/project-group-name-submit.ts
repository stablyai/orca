import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/group-keys'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  resolveProjectGroupOwnerHostId,
  runtimeTargetForProjectGroupOwner
} from '@/store/project-groups/project-group-owner-routing'
import type { RepoSlice } from '@/store/repos/repo-state'

export type ProjectGroupNameDialogState =
  | { type: 'create-from-repo'; repo: Repo }
  | {
      type: 'create-empty'
      hostId: ExecutionHostId | null
      parentGroupId?: string | null
      parentGroupName?: string
    }
  // hostId is the group row's owner host, so the mutation is not routed to whichever host has focus.
  | {
      type: 'rename'
      groupId: string
      currentName: string
      hostId?: ExecutionHostId
    }

export type ProjectGroupNameSubmitErrorKind = 'create-failed' | 'rename-failed' | 'move-failed'

export function resolveSubgroupCreationHostId(
  projectGroups: readonly ProjectGroup[],
  parentGroupId: string,
  hostId?: ExecutionHostId
): ExecutionHostId | null {
  const target = runtimeTargetForProjectGroupOwner({ projectGroups }, parentGroupId, hostId)
  if (!target) {
    return null
  }
  return (
    resolveProjectGroupOwnerHostId({ projectGroups, settings: null }, parentGroupId, hostId) ??
    getRuntimeTargetHostId(target)
  )
}

export async function submitProjectGroupNameDialog(
  state: ProjectGroupNameDialogState,
  name: string,
  deps: {
    createProjectGroup: RepoSlice['createProjectGroup']
    moveProjectToGroup: RepoSlice['moveProjectToGroup']
    updateProjectGroup: RepoSlice['updateProjectGroup']
    onExpandGroupKey?: (groupKey: string) => void
    onError: (kind: ProjectGroupNameSubmitErrorKind) => void
  }
): Promise<void> {
  if (state.type === 'create-empty') {
    if (!state.hostId) {
      deps.onError('create-failed')
      throw new Error('project_group_create_failed')
    }
    let parentMoveRejected = false
    const group = await deps.createProjectGroup(
      name,
      state.hostId,
      state.parentGroupId
        ? {
            parentGroupId: state.parentGroupId,
            onParentMoveRejected: () => {
              parentMoveRejected = true
            }
          }
        : undefined
    )
    if (!group) {
      if (!parentMoveRejected) {
        deps.onError('create-failed')
      }
      throw new Error('project_group_create_failed')
    }
    if (state.parentGroupId) {
      deps.onExpandGroupKey?.(getProjectGroupHeaderKey(state.parentGroupId))
    }
    return
  }

  if (state.type === 'create-from-repo') {
    const group = await deps.createProjectGroup(name, getRepoExecutionHostId(state.repo))
    if (!group) {
      deps.onError('create-failed')
      throw new Error('project_group_create_failed')
    }
    const moved = await deps.moveProjectToGroup(state.repo, group.id)
    if (!moved) {
      deps.onError('move-failed')
    }
    return
  }

  const renamed = await deps.updateProjectGroup(state.groupId, { name }, { hostId: state.hostId })
  if (!renamed) {
    deps.onError('rename-failed')
    throw new Error('project_group_rename_failed')
  }
}
