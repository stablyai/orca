export type HoveredWorkspaceDocument = Pick<Document, 'activeElement' | 'querySelectorAll'>

export function getHoveredWorkspaceIdentity(
  doc: HoveredWorkspaceDocument = document
): { hostIdentity: string; workspaceId: string } | null {
  const hoveredRows = doc.querySelectorAll<HTMLElement>(
    '[data-worktree-sidebar] [role="option"][data-worktree-id]:hover'
  )
  const row = hoveredRows.item(hoveredRows.length - 1)
  const workspaceId = row?.dataset.worktreeId
  const hostIdentity = row?.dataset.worktreeHostIdentity
  return workspaceId && hostIdentity ? { workspaceId, hostIdentity } : null
}
