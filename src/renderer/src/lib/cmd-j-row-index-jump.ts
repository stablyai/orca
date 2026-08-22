type CmdJRowIndexJumpListener = (index: number) => void

const listeners = new Set<CmdJRowIndexJumpListener>()

/**
 * Cmd+J owns the digit chord while it is open: the main process still resolves it to
 * `ui:jumpToWorktreeIndex`, and the IPC listener hands the zero-based index here instead of
 * switching workspaces behind the overlay. Indexes past the rendered rows are swallowed —
 * doing nothing beats switching workspaces the user can't see.
 */
export function subscribeCmdJRowIndexJump(listener: CmdJRowIndexJumpListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitCmdJRowIndexJump(index: number): void {
  for (const listener of listeners) {
    listener(index)
  }
}
