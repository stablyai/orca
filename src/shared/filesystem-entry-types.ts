export type FilesystemPathFlavor = 'posix' | 'win32'

export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type FileDocument = {
  filePath: string
  relativePath: string
  basename: string
  name: string
}

export type MarkdownDocument = FileDocument

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
