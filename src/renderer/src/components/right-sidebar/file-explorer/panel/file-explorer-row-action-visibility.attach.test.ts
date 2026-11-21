import { describe, expect, it } from 'vitest'
import type { TreeNode } from '../tree/file-explorer-types'
import { shouldShowAttachAsContextAction } from './file-explorer-row-action-visibility'

function node(isDirectory: boolean): TreeNode {
  return {
    name: isDirectory ? 'src' : 'index.ts',
    path: '/repo/src',
    isDirectory
  } as TreeNode
}

describe('attach as context visibility', () => {
  it('only shows attach as context for files', () => {
    expect(shouldShowAttachAsContextAction(node(false))).toBe(true)
    expect(shouldShowAttachAsContextAction(node(true))).toBe(false)
  })
})
