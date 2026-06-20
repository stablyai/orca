// Why: remote Git can legitimately transfer large histories, while auth and
// transport helpers otherwise have no upper bound when they become stuck.
export const GIT_REMOTE_OPERATION_TIMEOUT_MS = 120_000
// Let the subprocess return its operation-specific error before transport cancellation wins.
export const GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS = GIT_REMOTE_OPERATION_TIMEOUT_MS + 5_000
