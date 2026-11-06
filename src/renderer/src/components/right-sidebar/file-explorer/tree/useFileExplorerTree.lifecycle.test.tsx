// @vitest-environment happy-dom
import { StrictMode, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

const read = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
vi.mock('../navigation/file-explorer-operation-owner', async (original) => ({
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

beforeEach(() => read.mockReset().mockResolvedValue(listing()))
afterEach(cleanup)

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
        workspaceKey: null,
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
