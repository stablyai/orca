// ─── Filesystem ─────────────────────────────────────────────
export type FilesystemPathFlavor = 'posix' | 'win32'

export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type MarkdownDocument = {
  filePath: string
  relativePath: string
  basename: string
  name: string
}

// ─── Filesystem watcher ─────────────────────────────────────
export type FsChangeEvent = {
  kind: 'create' | 'update' | 'delete' | 'rename' | 'overflow'
  absolutePath: string
  oldAbsolutePath?: string
  isDirectory?: boolean
}

export type FsChangedPayload = {
  /** Desktop SSH events carry their connection; absent means client-local. */
  connectionId?: string
  worktreePath: string
  events: FsChangeEvent[]
}
