// Deadlines the page and shell share for host operations that legitimately outlive the default.

// Why: desktop remote worktree creation uses the same 10-minute RPC budget.
// SSH clone/setup/startup can legitimately exceed the generic mobile RPC timeout.
export const WORKTREE_CREATE_TIMEOUT_MS = 10 * 60_000

// Why: a commit-message agent run is bounded at 60s on the desktop, plus transport slack.
export const COMMIT_MESSAGE_GENERATION_TIMEOUT_MS = 65_000
