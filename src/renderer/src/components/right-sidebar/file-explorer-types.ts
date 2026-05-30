export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  depth: number
}

export type DirCache = {
  children: TreeNode[]
  loading: boolean
}
