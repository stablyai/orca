import { describe, expect, it } from 'vitest'
import {
  isFileExplorerNodeReadOnly,
  isFileExplorerSelectionDragBlocked,
  shouldShowCopyRelativePathAction,
  shouldShowFindInFolderAction
} from './file-explorer-row-action-visibility'
import { directoryNode, fileNode } from '../tree/file-explorer-tree-node-test-fixtures'

const outsidePath = '/tmp/reference/outside.ts'

describe('file explorer rows outside the workspace', () => {
  it('hides find in folder for read-only rows', () => {
    expect(shouldShowFindInFolderAction(directoryNode, true)).toBe(false)
  })

  it('keeps workspace descendants writable when browsing from an outside ancestor', () => {
    expect(isFileExplorerNodeReadOnly(fileNode, '/repo', true)).toBe(false)
    expect(
      isFileExplorerNodeReadOnly(
        { ...fileNode, path: outsidePath, relativePath: outsidePath },
        '/repo',
        true
      )
    ).toBe(true)
  })

  it('hides copy relative path for outside nodes', () => {
    expect(shouldShowCopyRelativePathAction(fileNode, false)).toBe(true)
    expect(shouldShowCopyRelativePathAction(fileNode, true)).toBe(false)
  })

  it('blocks dragging a writable row when the selection includes an outside node', () => {
    const selection = new Set([fileNode.path, outsidePath])

    expect(isFileExplorerSelectionDragBlocked(fileNode.path, selection, '/repo', true)).toBe(true)
    expect(isFileExplorerSelectionDragBlocked(fileNode.path, selection, '/repo', false)).toBe(false)
    expect(
      isFileExplorerSelectionDragBlocked(fileNode.path, new Set([fileNode.path]), '/repo', true)
    ).toBe(false)
  })
})
