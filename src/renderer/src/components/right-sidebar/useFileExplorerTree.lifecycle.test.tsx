// @vitest-environment happy-dom
import { StrictMode, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import { FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY } from './file-explorer-refresh-concurrency'

const read = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
vi.mock('./file-explorer-operation-owner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({
    kind: 'runtime',
    environmentId: 'host-a',
    executionHostId: 'runtime:host-a'
  })
}))
const listing = () => ({
  entries: [{ name: 'fresh.txt', isDirectory: false, isSymlink: false }],
  operationOwner: { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' }
})
function gateRead() {
  let resolve!: (value: ReturnType<typeof listing>) => void
  const promise = new Promise<ReturnType<typeof listing>>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
beforeEach(() => read.mockReset().mockResolvedValue(listing()))
afterEach(cleanup)

it('stops a retired tree before its root response can launch expanded-directory reads', async () => {
  const gate = gateRead()
  read.mockReturnValueOnce(gate.promise)
  const hook = renderHook(() => useFileExplorerTree('/repo', new Set(['/repo/subdir']), 'wt'))
  let refresh!: ReturnType<typeof hook.result.current.refreshTree>
  act(() => {
    refresh = hook.result.current.refreshTree()
  })
  hook.unmount()
  gate.resolve(listing())
  expect(await refresh).toBe('superseded')
  expect(read).toHaveBeenCalledTimes(1)
})

it('cancels queued remote directory reads when an expanded refresh is retired', async () => {
  const gates = Array.from({ length: FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY }, gateRead)
  read.mockImplementation((_id, _root, path) =>
    path === '/repo'
      ? Promise.resolve(listing())
      : (gates.shift()?.promise ?? Promise.resolve(listing()))
  )
  const pending = [...gates]
  const expanded = new Set(Array.from({ length: 20 }, (_, index) => `/repo/dir-${index}`))
  const hook = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt'))
  let refresh!: ReturnType<typeof hook.result.current.refreshTree>
  await act(async () => {
    refresh = hook.result.current.refreshTree()
    await Promise.resolve()
  })
  expect(read).toHaveBeenCalledTimes(FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY + 1)
  hook.unmount()
  for (const gate of pending) {
    gate.resolve(listing())
  }
  expect(await refresh).toBe('superseded')
  expect(read).toHaveBeenCalledTimes(FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY + 1)
})

function StrictWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>
}
function renderVisibleTree(strict = false) {
  const resetSelection = vi.fn()
  const setNameFilterQuery = vi.fn()
  const expanded = new Set<string>()
  return renderHook(
    ({ visible }) => {
      const tree = useFileExplorerTree('/repo', expanded, 'wt')
      useFileExplorerTreeLoadEffects({
        visibleFilesWorktreePath: visible ? '/repo' : null,
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
    { initialProps: { visible: true }, wrapper: strict ? StrictWrapper : undefined }
  )
}

it('restarts the initial read after StrictMode retires the first effect lifetime', async () => {
  const hook = renderVisibleTree(true)
  await act(async () => {
    await Promise.resolve()
  })
  expect(hook.result.current.rootCache?.children[0].name).toBe('fresh.txt')
  expect(hook.result.current.loadingDirPaths.size).toBe(0)
})

it('preserves the same host tree when Files is hidden and reopened', async () => {
  const hook = renderVisibleTree()
  await act(async () => {
    await Promise.resolve()
  })
  expect(read).toHaveBeenCalledTimes(1)
  hook.rerender({ visible: false })
  hook.rerender({ visible: true })
  await act(async () => {
    await Promise.resolve()
  })
  expect(read).toHaveBeenCalledTimes(1)
  expect(hook.result.current.rootCache?.children[0].name).toBe('fresh.txt')
})
