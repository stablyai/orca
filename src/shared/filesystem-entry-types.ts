// ─── Filesystem ─────────────────────────────────────────────
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

// ─── Filesystem watcher ─────────────────────────────────────
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
}
