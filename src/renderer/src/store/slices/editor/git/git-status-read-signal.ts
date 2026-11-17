type GitStatusReadListener = (worktreeId: string) => void

const listeners = new Set<GitStatusReadListener>()

/** Fires after every successful status read, including unchanged ones the store does not publish. */
export function onGitStatusRead(listener: GitStatusReadListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitGitStatusRead(worktreeId: string): void {
  for (const listener of listeners) {
    listener(worktreeId)
  }
}
