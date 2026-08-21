// Why: worktree creation awaits this network fetch; a stalled remote must fail instead of hanging create.
export const REMOTE_TRACKING_FETCH_TIMEOUT_MS = 60_000
