export type FsChangeEvent = {
  kind: 'create' | 'update' | 'delete' | 'rename' | 'overflow'
  absolutePath: string
  oldAbsolutePath?: string
  isDirectory?: boolean
}

export type FsChangedPayload = {
  worktreePath: string
  events: FsChangeEvent[]
  /** SSH connection the root was watched on; absent for local roots. Lets the renderer tell a local and an SSH root at the same path apart. */
  connectionId?: string
  /** Set on an overflow sent because the watch was down (re-watch, late install, reconnect), not because events were too many. */
  resync?: true
}

/** Main -> renderer: auto-reload for a local watch root stopped (crash-fuse cooldown, capacity or distro wait, unwatchable root, stalled OS events) or resumed. */
export type FsWatchPausedPayload = {
  /** The watch root path, spelled as in FsChangedPayload.worktreePath. */
  worktreePath: string
  paused: boolean
}
