// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import { useFileExplorerReveal } from './useFileExplorerReveal'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { createFileExplorerRowProjectionFromParts } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'

const store = vi.hoisted(() => ({
  setState: vi.fn(),
  getState: vi.fn()
}))
const setRoot = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: store }))
afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

function fixture(filePath = '/repo/packages/app/index.ts') {
  const node: TreeNode = {
    name: 'index.ts',
    path: '/repo/packages/app/index.ts',
    relativePath: 'packages/app/index.ts',
    depth: 2,
    isDirectory: false
  }
  const projection = createFileExplorerRowProjectionFromParts([node], new Map([[node.path, node]]))
  const request = {
    worktreeId: 'wt',
    filePath,
    requestId: 1,
    flash: false,
    origin: 'manual' as const
  }
  store.getState.mockReturnValue({
    setExplorerDisplayRootForWorktree: setRoot,
    pendingExplorerReveal: request,
    activeWorktreeId: 'wt',
    activeFileId: null,
    openFiles: []
  })
  return {
    activeWorktreeId: 'wt',
    worktreePath: '/repo',
    displayRootPath: '/repo/packages/app',
    pendingExplorerReveal: request,
    clearPendingExplorerReveal: vi.fn(),
    expanded: new Set<string>(),
    dirCache: { '/repo': { children: [node] }, '/repo/packages/app': { children: [node] } },
    loadingDirPaths: new Set<string>(),
    rootCache: { children: [node] },
    rowProjection: projection,
    observeDirForReveal: vi.fn().mockResolvedValue('refreshed'),
    getRevealAuthority: vi.fn(() => 'ready' as const),
    loadRevision: 0,
    setSelectedPath: vi.fn(),
    setFlashingPath: vi.fn(),
    flashTimeoutRef: { current: null },
    virtualizer: new Virtualizer<HTMLDivElement, Element>({
      count: 1,
      getScrollElement: () => null,
      estimateSize: () => 24,
      scrollToFn: vi.fn(),
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn()
    })
  }
}

it('reveals a scoped child without waiting for hidden ancestor rows', () => {
  const args = fixture()
  renderHook(() => useFileExplorerReveal(args))
  expect(args.observeDirForReveal).toHaveBeenCalledWith(
    '/repo/packages/app',
    1,
    'manual',
    expect.any(Function)
  )
  expect(args.setSelectedPath).toHaveBeenCalledWith('/repo/packages/app/index.ts')
  expect(args.clearPendingExplorerReveal).toHaveBeenCalled()
  expect(setRoot).not.toHaveBeenCalled()
})

it('switches to full root without consuming an out-of-scope explicit request', () => {
  const args = fixture('/repo/README.md')
  renderHook(() => useFileExplorerReveal(args))
  expect(setRoot).toHaveBeenCalledWith('wt', '/')
  expect(args.clearPendingExplorerReveal).not.toHaveBeenCalled()
  expect(args.observeDirForReveal).not.toHaveBeenCalled()
})

it('does not enqueue auto-reveal for an editor file outside scope', () => {
  const args = fixture()
  store.getState.mockReturnValue({
    activeFileId: 'readme',
    activeWorktreeId: 'wt',
    pendingExplorerReveal: null
  })
  renderHook(() =>
    useFileExplorerAutoReveal({
      ...args,
      pendingExplorerReveal: null,
      activeFileId: 'readme',
      openFiles: [
        {
          id: 'readme',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          worktreeId: 'wt',
          mode: 'edit',
          language: 'markdown',
          isDirty: false
        }
      ]
    })
  )
  expect(store.setState).not.toHaveBeenCalled()
  expect(args.setSelectedPath).not.toHaveBeenCalled()
})
