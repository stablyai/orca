import { useAppStore } from '@/store'

// Late creates must not steal another worktree's view; Checks may still show this review by following terminal cwd.
export function createdReviewIsForeground(
  worktreeId: string | null,
  panelShowsReview = false
): boolean {
  return panelShowsReview || useAppStore.getState().activeWorktreeId === worktreeId
}
