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
  /** Local desktop document watches never recurse into child directories. */
  shallow?: true
  // Desktop SSH events identify their host; client-local events omit this field.
  connectionId?: string
  worktreePath: string
  events: FsChangeEvent[]
}
