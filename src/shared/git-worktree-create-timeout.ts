// Why: worktree creation touches cloud and remote filesystems that can stall indefinitely.
export const GIT_WORKTREE_CREATE_TIMEOUT_MS = 180_000
