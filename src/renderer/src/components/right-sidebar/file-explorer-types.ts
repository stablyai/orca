import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DirEntryCursor } from '../../../../shared/file-dir-page'

export type FileExplorerOperationOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string; executionHostId: ExecutionHostId }
  | { kind: 'unresolved' }

export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  /** Inferred from an opened link, not the parent's latest host listing. */
  isDirectoryFromOpenedLink?: boolean
  depth: number
  /** Host snapshot that produced this node. Destructive actions fail closed without it. */
  operationOwner?: FileExplorerOperationOwner
}

/** Keep loading outside dirCache to avoid rebuilding the tree; see file-explorer-dir-load-state.ts. */
/** The host's last listed entry of a partly listed folder; the next page starts after it. */
export type FileExplorerDirMore = { after: DirEntryCursor }

export type DirCache = {
  error?: string
  children: TreeNode[]
  operationOwner?: FileExplorerOperationOwner
  /** Present while the host holds entries not yet listed here. */
  more?: FileExplorerDirMore
  /** Listed in pages because it is too big for one remote reply; a refresh pages straight away. */
  paged?: true
}

/** Retry covered dir reads after supersession, but not unreadable roots, which would add one dead transport timeout per dir. */
export type FileExplorerTreeRefreshOutcome = 'refreshed' | 'superseded' | 'root-unreadable'
