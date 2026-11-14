// Retry that ends in renderable details moves focus to the PR header instead of dropping it to body.
let pendingWorktreeId: string | null = null

export function requestReviewHeaderFocusAfterRetry(worktreeId: string | null): void {
  pendingWorktreeId = worktreeId
}

export function cancelReviewHeaderFocusAfterRetry(): void {
  pendingWorktreeId = null
}

export function takeReviewHeaderFocusAfterRetry(worktreeId: string | null): boolean {
  const pending = pendingWorktreeId !== null && pendingWorktreeId === worktreeId
  pendingWorktreeId = null
  // Respect focus the user already moved; only replace focus the removed Retry button dropped.
  return pending && (document.activeElement === null || document.activeElement === document.body)
}
