// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useFileExplorerReveal } from './useFileExplorerReveal'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { createFileExplorerRowProjectionFromParts } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'

const store = vi.hoisted(() => ({
  setState: vi.fn(),
  getState: () => ({ setExplorerDisplayRootForWorktree: setRoot })
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
  return {
    activeWorktreeId: 'wt',
    worktreePath: '/repo',
    displayRootPath: '/repo/packages/app',
    pendingExplorerReveal: { worktreeId: 'wt', filePath, requestId: 1, flash: false },
    clearPendingExplorerReveal: vi.fn(),
    expanded: new Set<string>(),
    dirCache: { '/repo/packages/app': { children: [node] } },
    loadingDirPaths: new Set<string>(),
    rootCache: { children: [node] },
    rowProjection: projection,
    loadDir: vi.fn().mockResolvedValue(true),
    setSelectedPath: vi.fn(),
    setFlashingPath: vi.fn(),
    flashTimeoutRef: { current: null },
    virtualizer: { scrollToIndex: vi.fn() } as unknown as Virtualizer<HTMLDivElement, Element>
  }
}

it('reveals a scoped child without waiting for hidden ancestor rows', () => {
  const args = fixture()
  renderHook(() => useFileExplorerReveal(args))
  expect(args.loadDir).toHaveBeenCalledWith('/repo/packages/app', 1)
  expect(args.setSelectedPath).toHaveBeenCalledWith('/repo/packages/app/index.ts')
  expect(args.clearPendingExplorerReveal).toHaveBeenCalled()
  expect(setRoot).not.toHaveBeenCalled()
})

it('switches to full root without consuming an out-of-scope explicit request', () => {
  const args = fixture('/repo/README.md')
  renderHook(() => useFileExplorerReveal(args))
  expect(setRoot).toHaveBeenCalledWith('wt', '/')
  expect(args.clearPendingExplorerReveal).not.toHaveBeenCalled()
  expect(args.loadDir).not.toHaveBeenCalled()
})

it('does not enqueue auto-reveal for an editor file outside scope', () => {
  const args = fixture()
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
          mode: 'edit'
        }
      ] as never
    })
  )
  expect(store.setState).not.toHaveBeenCalled()
  expect(args.setSelectedPath).not.toHaveBeenCalled()
})
