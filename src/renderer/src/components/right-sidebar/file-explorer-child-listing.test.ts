import { expect, it } from 'vitest'
import {
  findNormalizedFileExplorerChild,
  hasExactFileExplorerSymlink
} from './file-explorer-child-listing'
import type { TreeNode } from './file-explorer-types'

it('keeps normalized last-wins rows distinct from exact existential link evidence', () => {
  const first: TreeNode = {
    path: 'C:\\Repo\\link',
    name: 'first',
    relativePath: 'link',
    depth: 0,
    isDirectory: true,
    isSymlink: true
  }
  const last: TreeNode = { ...first, path: 'c:/repo/link', name: 'last', isSymlink: false }
  for (const children of [
    [first, last],
    [last, first]
  ]) {
    expect(hasExactFileExplorerSymlink(children, first.path)).toBe(true)
    expect(hasExactFileExplorerSymlink(children, last.path)).toBe(false)
    expect(hasExactFileExplorerSymlink(children, 'C:/REPO/LINK')).toBe(false)
    expect(findNormalizedFileExplorerChild(children, 'C:/REPO/LINK')).toBe(children[1])
  }
  const duplicate = { ...first, isSymlink: false }
  for (const children of [
    [first, duplicate],
    [duplicate, first]
  ]) {
    expect(hasExactFileExplorerSymlink(children, first.path)).toBe(true)
    expect(findNormalizedFileExplorerChild(children, first.path)).toBe(children[1])
  }
})
