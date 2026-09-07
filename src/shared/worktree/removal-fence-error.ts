// Shared between main (which throws these at the PTY/watcher install fence while
// a worktree is being removed) and the renderer (which recognizes them so a
// doomed pane never surfaces the fence as a user-facing terminal error).

export const TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE =
  'Terminal cannot start while the worktree is being removed'

export const WATCHER_REMOVAL_IN_PROGRESS_MESSAGE =
  'File watcher cannot start while the worktree is being removed'

// Why: both fence messages end with this tail. Matching the tail catches the
// terminal and watcher variants even after Electron IPC prefixes the rejected
// error with its own "Error invoking remote method ..." text.
const REMOVAL_IN_PROGRESS_FENCE_TAIL = 'cannot start while the worktree is being removed'

export function isWorktreeRemovalFenceError(message: string): boolean {
  return message.includes(REMOVAL_IN_PROGRESS_FENCE_TAIL)
}
