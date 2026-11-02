// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'
import { getExplorerEffectiveExpanded } from './file-explorer-display-root'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

const read = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
vi.mock('./file-explorer-operation-owner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' })
}))
const listing = (name?: string) => ({
  entries: name ? [{ name, isDirectory: false }] : [],
  operationOwner: { kind: 'local' }
})
beforeEach(() => read.mockReset().mockResolvedValue(listing()))
afterEach(cleanup)

it.each(['Host unavailable', ''])(
  'preserves cached children on refresh failure (%j) and recovers',
  async (message) => {
    const expanded = getExplorerEffectiveExpanded(new Set(), '/repo/packages/app')
    const { result } = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt'))
    read.mockResolvedValueOnce(listing('before.ts'))
    await act(async () => {
      await result.current.loadDir('/repo/packages/app', 1)
    })
    read.mockImplementation(async (_id, _root, path) => {
      if (path === '/repo/packages/app') {
        throw new Error(message)
      }
      return listing()
    })
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(result.current.dirCache['/repo/packages/app']).toMatchObject({
      error: message,
      children: [{ relativePath: 'packages/app/before.ts', depth: 2 }]
    })
    read.mockResolvedValue(listing('after.ts'))
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(result.current.dirCache['/repo/packages/app'].error).toBeUndefined()
    expect(result.current.dirCache['/repo/packages/app'].children[0]).toMatchObject({
      relativePath: 'packages/app/after.ts',
      depth: 2
    })
  }
)

it('distinguishes an unreadable scoped directory from an empty one and allows forced retry', async () => {
  const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt'))
  read.mockRejectedValueOnce(new Error('Permission denied'))
  await act(async () => {
    await result.current.loadDir('/repo/app', 0)
  })
  expect(result.current.rootError).toBeNull()
  expect(result.current.dirCache['/repo/app'].error).toBe('Permission denied')
  await act(async () => {
    await result.current.refreshDir('/repo/app')
  })
  expect(result.current.dirCache['/repo/app']).toMatchObject({ children: [] })
  expect(result.current.dirCache['/repo/app'].error).toBeUndefined()
})

it('loads and refreshes an outside tree root while retaining workspace file identity', async () => {
  read.mockResolvedValue(listing('package.json'))
  const { result } = renderHook(() =>
    useFileExplorerTree('/tmp/reference', new Set(), 'wt', '/repo')
  )

  await act(async () => {
    result.current.resetAndLoad()
  })

  expect(read).toHaveBeenCalledWith('wt', '/repo', '/tmp/reference', {
    wakeWslDistro: undefined
  })
  expect(result.current.rootCache?.children[0]).toMatchObject({
    path: '/tmp/reference/package.json',
    relativePath: '/tmp/reference/package.json',
    depth: 0
  })
  await act(async () => {
    await result.current.refreshTree()
  })
  expect(read).toHaveBeenLastCalledWith('wt', '/repo', '/tmp/reference', {
    paged: undefined,
    minEntries: 1,
    wakeWslDistro: undefined
  })
})

it('keeps refreshed outside children addressed by absolute path so they stay read-only', async () => {
  read.mockResolvedValue(listing('a.ts'))
  const expanded = new Set(['/tmp/reference/src'])
  const { result } = renderHook(() =>
    useFileExplorerTree('/tmp/reference', expanded, 'wt', '/repo')
  )

  await act(async () => {
    await result.current.refreshTree()
  })

  expect(result.current.dirCache['/tmp/reference/src'].children[0]).toMatchObject({
    path: '/tmp/reference/src/a.ts',
    relativePath: '/tmp/reference/src/a.ts'
  })
})

it('refreshes only the expanded folders the displayed outside tree shows', async () => {
  const expanded = new Set(['/tmp/reference/src', '/repo/src'])
  const { result } = renderHook(() =>
    useFileExplorerTree('/tmp/reference', expanded, 'wt', '/repo')
  )

  await act(async () => {
    await result.current.refreshTree()
  })

  const readPaths = read.mock.calls.map((call) => call[2])
  expect(readPaths).toEqual(['/tmp/reference', '/tmp/reference/src'])
})

it('retains workspace-relative depth when the tree starts at a nested sparse root', async () => {
  read.mockResolvedValue(listing('index.ts'))
  const { result } = renderHook(() =>
    useFileExplorerTree('/repo/packages/app', new Set(), 'wt', '/repo')
  )

  await act(async () => {
    result.current.resetAndLoad()
  })

  expect(result.current.rootCache?.children[0]).toMatchObject({
    relativePath: 'packages/app/index.ts',
    depth: 2
  })
  expect(result.current.sourceWorkspaceId).toBe('wt')
})

it('drops a failed read of the previous root once the user browses elsewhere', async () => {
  let failPreviousRoot: (error: Error) => void = () => {}
  read.mockImplementation(async (_id: string, _workspace: string, path: string) =>
    path === '/repo'
      ? new Promise((_resolve, reject) => {
          failPreviousRoot = reject
        })
      : listing('a.ts')
  )
  const expanded = new Set<string>()
  const hook = renderHook(
    ({ root }) => {
      const tree = useFileExplorerTree(root, expanded, 'wt', '/repo')
      useFileExplorerTreeLoadEffects({
        workspaceKey: 'wt',
        visibleFilesWorktreePath: root,
        workspacePath: '/repo',
        displayRootPath: root,
        expanded,
        dirCache: tree.dirCache,
        loadingDirPaths: tree.loadingDirPaths,
        rootError: tree.rootError,
        isDirStale: tree.isDirStale,
        loadDir: tree.loadDir,
        refreshTree: tree.refreshTree,
        resetAndLoad: tree.resetAndLoad,
        resetSelection: vi.fn(),
        setNameFilterQuery: vi.fn()
      })
      return tree
    },
    { initialProps: { root: '/repo' } }
  )
  await act(async () => {})

  hook.rerender({ root: '/tmp/reference' })
  await act(async () => {})
  await act(async () => {
    failPreviousRoot(new Error('Host unavailable'))
  })

  // Browsing elsewhere resets the tree, so the old root's failure cannot mark the new one unreadable.
  expect(hook.result.current.rootError).toBeNull()
  expect(Object.keys(hook.result.current.dirCache)).toEqual(['/tmp/reference'])
  expect(hook.result.current.loadingDirPaths.size).toBe(0)
})
