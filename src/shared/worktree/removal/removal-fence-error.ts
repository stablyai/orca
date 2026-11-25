// Share install fences so the renderer suppresses terminal errors for panes already doomed by removal.

export const TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE =
  'Terminal cannot start while the worktree is being removed'

export const WATCHER_REMOVAL_IN_PROGRESS_MESSAGE =
  'File watcher cannot start while the worktree is being removed'

// Match both terminal/watcher tails through Electron IPC’s rejection prefix.
const REMOVAL_IN_PROGRESS_FENCE_TAIL = 'cannot start while the worktree is being removed'

export function isWorktreeRemovalFenceError(message: string): boolean {
  return message.includes(REMOVAL_IN_PROGRESS_FENCE_TAIL)
}
