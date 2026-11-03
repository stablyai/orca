import type { WorktreeCardController } from './use-worktree-card-controller'

/** The branch and title the identity hover card names. Derived from the workspace alone, so a
 *  template can place the hover card but never put words in it (its rename writes the title). */
export function getWorktreeCardHoverIdentity(
  card: Pick<
    WorktreeCardController,
    | 'newCardStyle'
    | 'compactCards'
    | 'isFolder'
    | 'branch'
    | 'identityDisplay'
    | 'visibleCardTitle'
    | 'cardProps'
    | 'worktree'
  >
): { branchName: string | undefined; workspaceTitle: string | undefined } {
  const { newCardStyle, compactCards, isFolder, branch, identityDisplay } = card
  const title = card.visibleCardTitle.trim()
  const showBranch =
    !isFolder &&
    branch.length > 0 &&
    !newCardStyle &&
    (!compactCards || branch !== card.worktree.displayName)
  const branchName = newCardStyle
    ? identityDisplay
    : compactCards && showBranch
      ? branch
      : undefined
  return {
    branchName,
    workspaceTitle: title.length > 0 && title !== branchName ? title : undefined
  }
}
