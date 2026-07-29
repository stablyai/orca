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
