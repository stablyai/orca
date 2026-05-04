export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  depth: number
}

export type DirCache = {
  children: TreeNode[]
  loading: boolean
}
