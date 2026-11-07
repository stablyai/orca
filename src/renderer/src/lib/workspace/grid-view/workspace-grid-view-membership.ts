export const WORKSPACE_GRID_VIEW_MAX_MEMBERS = 6

/** Adds a workspace to the grid view, seeding it with the active workspace so the first add shows both side by side. */
export function addWorkspaceGridViewMember(
  memberIds: readonly string[],
  workspaceId: string,
  activeWorkspaceId: string | null,
  isKnownWorkspace: (workspaceId: string) => boolean
): readonly string[] {
  if (memberIds.includes(workspaceId)) {
    return memberIds
  }
  // Why only at the limit: a member can look unknown while its host reconnects, so it is dropped
  // only when its slot is needed. Removed workspaces are never shown, so they make room first.
  const kept =
    memberIds.length >= WORKSPACE_GRID_VIEW_MAX_MEMBERS
      ? memberIds.filter(isKnownWorkspace)
      : memberIds
  const seeded =
    kept.length === 0 && activeWorkspaceId && activeWorkspaceId !== workspaceId
      ? [activeWorkspaceId]
      : kept
  if (seeded.length >= WORKSPACE_GRID_VIEW_MAX_MEMBERS) {
    return memberIds
  }
  return [...seeded, workspaceId]
}

/** Removes a workspace; a grid view left with one member is cleared because it would show a single pane. */
export function removeWorkspaceGridViewMember(
  memberIds: readonly string[],
  workspaceId: string
): readonly string[] {
  if (!memberIds.includes(workspaceId)) {
    return memberIds
  }
  const remaining = memberIds.filter((id) => id !== workspaceId)
  return remaining.length < 2 ? [] : remaining
}

/** Counts only members that still resolve, so removed workspaces never block adding. */
export function isWorkspaceGridViewFull(
  memberIds: readonly string[],
  isKnownWorkspace: (workspaceId: string) => boolean
): boolean {
  return memberIds.filter(isKnownWorkspace).length >= WORKSPACE_GRID_VIEW_MAX_MEMBERS
}

/**
 * The workspaces the workbench shows at once: every mountable grid view member while the active
 * workspace is one of them, otherwise just the active workspace.
 */
export function resolveVisibleWorkspaceIds({
  gridViewMemberIds,
  activeWorkspaceId,
  mountableWorkspaceIds
}: {
  gridViewMemberIds: readonly string[]
  activeWorkspaceId: string | null
  mountableWorkspaceIds: ReadonlySet<string>
}): string[] {
  if (!activeWorkspaceId) {
    return []
  }
  if (!gridViewMemberIds.includes(activeWorkspaceId)) {
    return [activeWorkspaceId]
  }
  const visible = gridViewMemberIds.filter((id) => mountableWorkspaceIds.has(id))
  return visible.length < 2 ? [activeWorkspaceId] : visible
}
