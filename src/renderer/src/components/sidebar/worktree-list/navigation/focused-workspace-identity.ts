/** The row the worktree list has keyboard focus on: its `aria-activedescendant` while the list itself holds focus. */
export function getFocusedWorkspaceIdentity(
  doc: Pick<Document, 'activeElement' | 'getElementById'> = document
): { hostIdentity: string; workspaceId: string } | null {
  const list = doc.activeElement
  // Why the list itself: a row selected earlier can keep `aria-activedescendant` after focus moved to a terminal (#40913).
  if (!list?.matches('[data-worktree-sidebar]')) {
    return null
  }
  const optionId = list.getAttribute('aria-activedescendant')
  const option = optionId ? doc.getElementById(optionId) : null
  const workspaceId = option?.dataset.worktreeId
  const hostIdentity = option?.dataset.worktreeHostIdentity
  return workspaceId && hostIdentity ? { workspaceId, hostIdentity } : null
}
