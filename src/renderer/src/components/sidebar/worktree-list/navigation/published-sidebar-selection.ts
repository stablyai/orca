import type { Worktree } from '../../../../../../shared/worktree/types'

// Why: shortcuts resolve targets outside React, so the mounted sidebar publishes its multi-selection here.
let publishedSelection: readonly Worktree[] = []

export function publishSidebarSelection(worktrees: readonly Worktree[]): void {
  publishedSelection = worktrees
}

export function getPublishedSidebarSelection(): readonly Worktree[] {
  return publishedSelection
}
