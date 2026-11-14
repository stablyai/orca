type CmdJRowIndexJumpListener = (index: number) => void

const listeners = new Set<CmdJRowIndexJumpListener>()

/** While Cmd+J is open, route digit IPC to its rows and swallow out-of-range indexes so shortcuts cannot switch workspaces behind the overlay. */
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
