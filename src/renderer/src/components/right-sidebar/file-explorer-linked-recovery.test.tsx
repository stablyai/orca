// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { useFileExplorerTree } from './useFileExplorerTree'

const readDirectoryMock = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileExplorerDirectory: readDirectoryMock
}))
vi.mock('./file-explorer-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' as const })
}))

function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory, isSymlink: false }
}

function listing(...entries: DirEntry[]) {
  return { entries, operationOwner: { kind: 'local' as const } }
}

afterEach(cleanup)

it('reopening stale alias during its older read eventually reloads it', async () => {
  const { useFileExplorerTreeLoadEffects } = await import('./use-file-explorer-tree-load-effects')
  const resetSelection = vi.fn()
  const setNameFilterQuery = vi.fn()
  readDirectoryMock
    .mockReset()
    .mockImplementation(async (_id, _root, path) =>
      path === '/repo'
        ? listing({ name: 'link', isDirectory: true, isSymlink: true })
        : listing(entry('old.ts'))
    )
  const hook = renderHook(
    ({ expanded }) => {
      const tree = useFileExplorerTree('/repo', expanded, 'wt-1')
      useFileExplorerTreeLoadEffects({
        visibleFilesWorktreePath: '/repo',
        expanded,
        dirCache: tree.dirCache,
        loadingDirPaths: tree.loadingDirPaths,
        rootError: tree.rootError,
        isDirStale: tree.isDirStale,
        loadDir: tree.loadDir,
        refreshTree: tree.refreshTree,
        resetAndLoad: tree.resetAndLoad,
        resetSelection,
        setNameFilterQuery
      })
      return tree
    },
    { initialProps: { expanded: new Set(['/repo/link']) } }
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(hook.result.current.dirCache['/repo/link'].children[0].name).toBe('old.ts')
  let releaseAlias!: (value: ReturnType<typeof listing>) => void
  const aliasGate = new Promise<ReturnType<typeof listing>>((resolve) => {
    releaseAlias = resolve
  })
  readDirectoryMock.mockImplementationOnce(() => aliasGate)
  let older!: Promise<void>
  act(() => {
    older = hook.result.current.refreshDir('/repo/link')
  })
  hook.rerender({ expanded: new Set() })
  await act(async () => {
    await hook.result.current.refreshTree()
  })
  expect(hook.result.current.isDirStale('/repo/link')).toBe(true)
  readDirectoryMock.mockResolvedValue(listing(entry('fresh.ts')))
  hook.rerender({ expanded: new Set(['/repo/link']) })
  await act(async () => {
    releaseAlias(listing(entry('old.ts')))
    await older
  })
  expect(hook.result.current.dirCache['/repo/link'].children[0].name).toBe('fresh.ts')
  cleanup()
})

it('a cached link recovers when its missing target directory returns', async () => {
  const { processFileExplorerFsPayload } = await import('./file-explorer-watch-reconcile')
  let phase: 'initial' | 'missing' | 'restored' = 'initial'
  readDirectoryMock.mockReset().mockImplementation(async (_id, _root, path) => {
    if (path === '/repo') {
      return listing({ name: 'link', isDirectory: phase !== 'missing', isSymlink: true })
    }
    if (phase === 'missing') {
      throw new Error('ENOENT')
    }
    return listing(entry(phase === 'initial' ? 'old.ts' : 'fresh.ts'))
  })
  const hook = renderHook(() => useFileExplorerTree('/repo', new Set(['/repo/link']), 'wt-1'))
  await act(async () => {
    await hook.result.current.loadDir('/repo', -1)
  })
  await act(async () => {
    await hook.result.current.loadDir('/repo/link', 0)
  })
  const dispatch = async (kind: 'delete' | 'create') => {
    const reads: Promise<unknown>[] = []
    await act(async () => {
      processFileExplorerFsPayload({
        payload: { worktreePath: '/repo', events: [{ kind, absolutePath: '/repo/target' }] },
        currentWorktreePath: '/repo',
        worktreeId: 'wt-1',
        cache: hook.result.current.dirCache,
        expanded: new Set(['/repo/link']),
        followSymlinks: true,
        setDirCache: hook.result.current.setDirCache,
        setSelectedPath: vi.fn(),
        refreshDir: (path) => {
          reads.push(hook.result.current.refreshDir(path))
        },
        refreshTree: () => {
          reads.push(hook.result.current.refreshTree())
        }
      })
      await Promise.all(reads)
    })
  }
  phase = 'missing'
  await dispatch('delete')
  expect(hook.result.current.dirCache['/repo/link'].error).toBe('ENOENT')
  expect(hook.result.current.dirCache['/repo'].children[0].isDirectory).toBe(false)
  phase = 'restored'
  await dispatch('create')
  expect(hook.result.current.dirCache['/repo'].children[0].isDirectory).toBe(true)
  expect(hook.result.current.dirCache['/repo/link'].error).toBeUndefined()
  expect(hook.result.current.dirCache['/repo/link'].children[0].name).toBe('fresh.ts')
  cleanup()
})
