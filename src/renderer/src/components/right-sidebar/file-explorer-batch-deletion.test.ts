import { describe, expect, it, vi } from 'vitest'
import { runBatchDeletion, selectDeletionRoots } from './file-explorer-batch-deletion'
import type { TreeNode } from './file-explorer-types'

function node(path: string, isDirectory = false): TreeNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    relativePath: path.replace(/^\//, ''),
    isDirectory,
    depth: 0
  }
}

describe('selectDeletionRoots', () => {
  it('keeps unrelated files and directories', () => {
    const nodes = [node('/repo/a.ts'), node('/repo/b.ts'), node('/repo/docs', true)]
    expect(selectDeletionRoots(nodes)).toEqual(nodes)
  })

  it('drops children of a selected directory', () => {
    const dir = node('/repo/docs', true)
    const child = node('/repo/docs/readme.md')
    const nested = node('/repo/docs/guides/intro.md')
    const outside = node('/repo/a.ts')
    expect(selectDeletionRoots([dir, child, nested, outside])).toEqual([dir, outside])
  })

  it('keeps siblings whose paths merely share a prefix', () => {
    const dir = node('/repo/docs', true)
    const lookalike = node('/repo/docs-old/readme.md')
    expect(selectDeletionRoots([dir, lookalike])).toEqual([dir, lookalike])
  })

  it('does not treat selected files as containers', () => {
    const file = node('/repo/a.ts')
    const other = node('/repo/a.ts/impossible-child')
    expect(selectDeletionRoots([file, other])).toEqual([file, other])
  })
})

describe('runBatchDeletion', () => {
  const roots = [node('/repo/a.ts'), node('/repo/b.ts'), node('/repo/c.ts')]

  it('asks for confirmation once and deletes every root in order', async () => {
    const confirmBatch = vi.fn().mockResolvedValue(true)
    const order: string[] = []
    const deleteNode = vi.fn(async (n: TreeNode) => {
      order.push(n.path)
      return true
    })

    const deleted = await runBatchDeletion({
      roots,
      needsConfirmation: true,
      confirmBatch,
      deleteNode
    })

    expect(confirmBatch).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'])
    expect(deleted).toEqual(roots)
  })

  it('deletes nothing when the batch confirmation is declined', async () => {
    const deleteNode = vi.fn()

    const deleted = await runBatchDeletion({
      roots,
      needsConfirmation: true,
      confirmBatch: vi.fn().mockResolvedValue(false),
      deleteNode
    })

    expect(deleted).toBeNull()
    expect(deleteNode).not.toHaveBeenCalled()
  })

  it('skips confirmation when none is needed', async () => {
    const confirmBatch = vi.fn()

    const deleted = await runBatchDeletion({
      roots,
      needsConfirmation: false,
      confirmBatch,
      deleteNode: vi.fn(async () => true)
    })

    expect(confirmBatch).not.toHaveBeenCalled()
    expect(deleted).toEqual(roots)
  })

  it('excludes failed deletes from the result but continues the batch', async () => {
    const deleteNode = vi.fn(async (n: TreeNode) => n.path !== '/repo/b.ts')

    const deleted = await runBatchDeletion({
      roots,
      needsConfirmation: false,
      confirmBatch: vi.fn(),
      deleteNode
    })

    expect(deleteNode).toHaveBeenCalledTimes(3)
    expect(deleted).toEqual([roots[0], roots[2]])
  })
})
