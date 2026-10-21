import { useAppStore } from '@/store'

// Why: a create that outlives its panel (e.g. after generation) must not reveal the review over a worktree the user has since switched to.
// A panel still showing the review counts too, since it can differ from the selected worktree (Checks follows the terminal cwd).
export function createdReviewIsForeground(
  worktreeId: string | null,
  panelShowsReview = false
): boolean {
  return panelShowsReview || useAppStore.getState().activeWorktreeId === worktreeId
}
