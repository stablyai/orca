import { useAppStore } from '@/store'

/** Why: Add Project opened from a client header must land the new project in that client. */
export function readTargetProjectGroupIdFromModalData(
  modalData: Record<string, unknown>
): string | null {
  return typeof modalData.targetProjectGroupId === 'string' &&
    modalData.targetProjectGroupId.length > 0
    ? modalData.targetProjectGroupId
    : null
}

export async function assignAddedRepoToTargetClient(repoId: string): Promise<void> {
  const state = useAppStore.getState()
  const targetGroupId = readTargetProjectGroupIdFromModalData(state.modalData)
  if (!targetGroupId) {
    return
  }
  if (!state.projectGroups.some((group) => group.id === targetGroupId)) {
    return
  }
  const repo = state.repos.find((entry) => entry.id === repoId)
  // Why: nested-folder "import as group" already places repos in a new group; reparent that group instead.
  if (!repo || repo.projectGroupId) {
    return
  }
  await state.moveProjectToGroup(repoId, targetGroupId)
}

export async function nestImportedGroupUnderTargetClient(groupId: string): Promise<void> {
  const state = useAppStore.getState()
  const targetGroupId = readTargetProjectGroupIdFromModalData(state.modalData)
  if (!targetGroupId || targetGroupId === groupId) {
    return
  }
  if (!state.projectGroups.some((group) => group.id === targetGroupId)) {
    return
  }
  await state.updateProjectGroup(groupId, { parentGroupId: targetGroupId })
}

export async function assignNestedImportToTargetClient(args: {
  groupId?: string
  projectIds: readonly string[]
}): Promise<void> {
  if (args.groupId) {
    await nestImportedGroupUnderTargetClient(args.groupId)
    return
  }
  for (const projectId of args.projectIds) {
    await assignAddedRepoToTargetClient(projectId)
  }
}
