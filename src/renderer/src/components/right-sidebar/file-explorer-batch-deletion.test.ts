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
  it('normalizes each selected path once instead of once per possible parent', () => {
    let reads = 0
    const nodes = Array.from({ length: 1000 }, (_, i) => ({
      ...node(`/repo/directory-${i}`, true),
      get path() {
        reads++
        return `/repo/directory-${i}`
      }
    }))
    const selected = selectDeletionRoots(nodes)
    expect(reads).toBe(2000)
    selected.forEach((entry, index) => expect(entry).toBe(nodes[index]))
  })

  it('preserves WSL case-sensitive paths while accepting UNC aliases', () => {
    const parent = node('//wsl.localhost/Ubuntu/Repo', true)
    const child = node('//wsl$/ubuntu/Repo/file')
    const outside = node('//wsl$/ubuntu/repo/file')
    expect(selectDeletionRoots([parent, child, outside])).toEqual([parent, outside])
  })

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

  it('reads directory membership once per selected node, including file-only selections', () => {
    let directoryReads = 0
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({
      ...node(`/repo/file-${index}.ts`),
      get isDirectory() {
        directoryReads += 1
        return false
      }
    }))
    const selected = selectDeletionRoots(nodes)
    expect(directoryReads).toBe(nodes.length)
    expect(selected).not.toBe(nodes)
    selected.forEach((entry, index) => expect(entry).toBe(nodes[index]))
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

  it('keeps repeated references but excludes distinct directories with the same path', () => {
    const dir = node('/repo/docs', true)
    expect(selectDeletionRoots([dir, dir])).toEqual([dir, dir])
    expect(selectDeletionRoots([dir, { ...dir }])).toEqual([])
    const file = node('/repo/docs')
    expect(selectDeletionRoots([file, dir])).toEqual([dir])
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
