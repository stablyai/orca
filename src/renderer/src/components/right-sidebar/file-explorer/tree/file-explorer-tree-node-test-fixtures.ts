import type { TreeNode } from './file-explorer-types'

export const directoryNode: TreeNode = {
  name: 'src',
  path: '/repo/src',
  relativePath: 'src',
  isDirectory: true,
  depth: 0
}
export const fileNode: TreeNode = {
  name: 'index.ts',
  path: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 1
}
