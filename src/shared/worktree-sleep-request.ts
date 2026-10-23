/** Main asks the renderer to Sleep workspaces and waits until their slept state is durable. */
export type WorktreeSleepRequest = {
  requestId: string
  worktreeIds: string[]
  /** A WSL move's pause: its browser tabs move with the project, so Sleep must not close them. */
  keepBrowserTabs?: true
}

export type WorktreeSleepResponse = {
  requestId: string
  /** Workspaces whose Sleep failed; they stay awake and retryable. */
  failedWorktreeIds?: string[]
  error?: string
}
