/** Main asks the renderer to Sleep workspaces and waits until their slept state is durable. */
export type WorktreeSleepRequest = {
  requestId: string
  worktreeIds: string[]
}

export type WorktreeSleepResponse = {
  requestId: string
  /** Workspaces whose Sleep failed; they stay awake and retryable. */
  failedWorktreeIds?: string[]
  error?: string
}
