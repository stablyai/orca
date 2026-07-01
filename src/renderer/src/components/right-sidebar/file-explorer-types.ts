export type FileExplorerRoot = {
  id: string
  name: string
  path: string
  worktreeId: string
  repoId: string
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  isActive: boolean
}

export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  depth: number
  rootId?: string
  rootName?: string
  rootPath?: string
  rootWorktreeId?: string
  rootRepoId?: string
  rootConnectionId?: string | null
  rootRuntimeEnvironmentId?: string | null
  isWorkspaceRoot?: boolean
}

export type DirCache = {
  children: TreeNode[]
  loading: boolean
}
