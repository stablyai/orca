import type { ExecutionHostId } from '../../../../shared/execution-host'

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
  depth: number
  /** Host snapshot that produced this node. Destructive actions fail closed without it. */
  operationOwner?: FileExplorerOperationOwner
}

export type DirCache = {
  children: TreeNode[]
  loading: boolean
  operationOwner?: FileExplorerOperationOwner
}

/**
 * How a full tree refresh ended.
 *
 * Why three states, not a boolean: a caller that dropped its own pending dir refreshes because the
 * tree refresh covered them must re-issue on `superseded` (someone newer owns those reads) but NOT
 * on `root-unreadable` — there the transport is down, and re-issuing buys one dead timeout per dir.
 */
export type FileExplorerTreeRefreshOutcome = 'refreshed' | 'superseded' | 'root-unreadable'
