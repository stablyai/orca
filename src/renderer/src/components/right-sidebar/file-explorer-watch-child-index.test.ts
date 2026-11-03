import { describe, expect, it, vi } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'

function reconcile(
  cache: Record<string, DirCache>,
  absolutePath: string
): { dir: ReturnType<typeof vi.fn>; tree: ReturnType<typeof vi.fn> } {
  const dir = vi.fn()
  const tree = vi.fn()
  processFileExplorerFsPayload({
    payload: {
      worktreePath: '/repo',
      events: [{ kind: 'update', absolutePath, isDirectory: false }]
    },
    currentWorktreePath: '/repo',
    worktreeId: 'wt-1',
    cache,
    expanded: new Set(),
    setDirCache: vi.fn(),
    setSelectedPath: vi.fn(),
    refreshDir: dir,
    refreshTree: tree
  })
  return { dir, tree }
}

function node(path: string): TreeNode {
  return {
    path,
    name: path,
    relativePath: path.slice('/repo/'.length),
    isDirectory: false,
    isSymlink: false,
    depth: 0,
    operationOwner: { kind: 'local' }
  }
}

describe('watcher sibling index reuse', () => {
  it('indexes unchanged siblings once across update payloads', () => {
    let reads = 0
    const children = Array.from({ length: 1_000 }, (_, index) => {
      const path = `/repo/file-${index}.ts`
      const child = node(path)
      Object.defineProperty(child, 'path', {
        get: () => {
          reads++
          return path
        }
      })
      return child
    })
    const cache = { '/repo': { children } }
    for (let payload = 0; payload < 10; payload++) {
      const refresh = reconcile(cache, '/repo/file-0.ts')
      expect(refresh.dir).not.toHaveBeenCalled()
      expect(refresh.tree).not.toHaveBeenCalled()
    }
    expect(reads).toBe(1_000)
  })

  it('reindexes replaced listings while reusing an unchanged array through cache copies', () => {
    const children = [node('/repo/old.ts')]
    const before = { '/repo': { children } }
    expect(reconcile(before, '/repo/old.ts').dir).not.toHaveBeenCalled()
    expect(reconcile({ ...before }, '/repo/old.ts').dir).not.toHaveBeenCalled()

    const after = { '/repo': { children: [node('/repo/new.ts')] } }
    expect(reconcile(after, '/repo/new.ts').dir).not.toHaveBeenCalled()
    expect(reconcile(after, '/repo/old.ts').dir).toHaveBeenCalledWith('/repo')
  })
})
