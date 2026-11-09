import type {
  ProjectGroup,
  ProjectGroupMutation
} from '../../../../shared/project/groups/project-group-types'

export type PersistProjectGroupUpdateOptions = {
  onParentGroupMoveRejected?: () => void
  onPinRejected?: () => void
  onPinFailed?: () => void
  allocateCommitSeq?: () => number
  onStageCommitted?: (group: ProjectGroup, commitSeq: number) => boolean | void
  onFinalCommitSeq?: (groupId: string, commitSeq: number) => void
}

export type SequencedProjectGroupResult = {
  row: ProjectGroup | null
  commitSeq: number
}

export function verifyProjectGroupMatchesUpdate(
  group: ProjectGroup | null | undefined,
  updates: ProjectGroupMutation['updates'],
  options?: PersistProjectGroupUpdateOptions
): group is ProjectGroup {
  if (!group) {
    if (updates.isPinned !== undefined) {
      options?.onPinFailed?.()
    }
    return false
  }
  if (
    updates.parentGroupId !== undefined &&
    (group.parentGroupId ?? null) !== updates.parentGroupId
  ) {
    options?.onParentGroupMoveRejected?.()
    return false
  }
  if (updates.isPinned !== undefined && group.isPinned !== updates.isPinned) {
    options?.onPinRejected?.()
    return false
  }
  return (
    (updates.rootProjectOrder === undefined ||
      (group.rootProjectOrder ?? null) === updates.rootProjectOrder) &&
    (updates.tabOrder === undefined || group.tabOrder === updates.tabOrder)
  )
}

export function splitRemoteParentGroupUpdate(updates: ProjectGroupMutation['updates']): {
  parentOnly: ProjectGroupMutation['updates'] | null
  remaining: ProjectGroupMutation['updates'] | null
} {
  if (updates.parentGroupId === undefined) {
    return { parentOnly: null, remaining: updates }
  }
  const { parentGroupId, ...rest } = updates
  return {
    parentOnly: { parentGroupId },
    remaining: Object.keys(rest).length > 0 ? rest : null
  }
}

export function finalizeSequencedResult(
  result: SequencedProjectGroupResult | undefined,
  groupId: string,
  options?: PersistProjectGroupUpdateOptions
): ProjectGroup | null {
  if (result?.row) {
    options?.onFinalCommitSeq?.(groupId, result.commitSeq)
    return result.row
  }
  return null
}
