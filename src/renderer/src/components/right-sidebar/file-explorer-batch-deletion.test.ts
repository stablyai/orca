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
  it('preserves WSL case-sensitive paths while accepting UNC aliases', () => {
    const parent = node('//wsl.localhost/Ubuntu/Repo', true)
    const child = node('//wsl$/ubuntu/Repo/file')
    const outside = node('//wsl$/ubuntu/repo/file')
    expect(selectDeletionRoots([parent, child, outside])).toEqual([parent, outside])
  })

  it('preserves order, node identity and host ownership when children precede parents', () => {
    const child = node('/repo/docs/guide.md')
    const first = { ...node('/repo/first.ts'), operationOwner: { kind: 'local' as const } }
    const parent = {
      ...node('/repo/docs', true),
      operationOwner: { kind: 'ssh' as const, connectionId: 'ssh-owner' }
    }
    const last = {
      ...node('/repo/last.ts'),
      operationOwner: { kind: 'unresolved' as const }
    }
    const nodes = [child, first, parent, last]
    const selected = selectDeletionRoots(nodes)
    expect(selected).toEqual([first, parent, last])
    expect(selected[0]).toBe(first)
    expect(selected[1]).toBe(parent)
    expect(selected[2]).toBe(last)
    expect(nodes).toEqual([child, first, parent, last])
  })

  it.each([
    ['/repo/docs/', '/repo/docs/guide.md', '/repo/docs-other/guide.md'],
    ['C:\\Repo\\Docs\\', 'c:/repo/docs/guide.md', 'C:/Repo/Docs-other/guide.md'],
    ['\\\\Server\\Share\\Docs', '//server/share/docs/guide.md', '//server/other/docs/guide.md']
  ])('retains path boundaries for %s', (parentPath, childPath, outsidePath) => {
    const parent = node(parentPath, true)
    const child = node(childPath)
    const outside = node(outsidePath)
    expect(selectDeletionRoots([outside, child, parent])).toEqual([outside, parent])
  })

  it('keeps case-distinct POSIX paths', () => {
    const parent = node('/repo/Docs', true)
    const outside = node('/repo/docs/guide.md')
    expect(selectDeletionRoots([outside, parent])).toEqual([outside, parent])
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
