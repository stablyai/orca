// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import type { OpenFile } from '@/store/slices/editor'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'

const { mockSetState } = vi.hoisted(() => ({
  mockSetState: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    setState: mockSetState
  }
}))

function mockProjection(hasPathResult = false, indexResult = 0): FileExplorerRowProjection {
  return {
    hasPath: vi.fn().mockReturnValue(hasPathResult),
    getIndexByPath: vi.fn().mockReturnValue(indexResult)
  } as unknown as FileExplorerRowProjection
}

describe('useFileExplorerAutoReveal', () => {
  const defaultParams = {
    activeWorktreeId: 'wt-1',
    worktreePath: '/repo/wt',
    pendingExplorerReveal: null,
    setSelectedPath: vi.fn(),
    virtualizer: { scrollToIndex: vi.fn() } as unknown as Virtualizer<HTMLDivElement, Element>
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('triggers auto-reveal for edit mode tabs', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'file-1',
        filePath: '/repo/wt/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'edit'
      }
    ]
    const projection = mockProjection(true, 5)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'file-1',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(projection.hasPath).toHaveBeenCalledWith('/repo/wt/src/index.ts')
    expect(setSelectedPath).toHaveBeenCalledWith('/repo/wt/src/index.ts')
  })

  it('triggers auto-reveal for markdown-preview tabs', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'markdown-preview-1',
        filePath: '/repo/wt/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        isDirty: false,
        mode: 'markdown-preview'
      }
    ]
    const projection = mockProjection(true, 3)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'markdown-preview-1',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).toHaveBeenCalledWith('/repo/wt/docs/README.md')
  })

  it('triggers auto-reveal for unstaged working-tree diff tabs', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-1',
        filePath: '/repo/wt/src/app.ts',
        relativePath: 'src/app.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'unstaged'
      }
    ]
    const projection = mockProjection(true, 2)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-1',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).toHaveBeenCalledWith('/repo/wt/src/app.ts')
  })

  it('triggers auto-reveal for staged working-tree diff tabs', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-staged',
        filePath: '/repo/wt/src/staged.ts',
        relativePath: 'src/staged.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'staged'
      }
    ]
    const projection = mockProjection(true, 1)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-staged',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).toHaveBeenCalledWith('/repo/wt/src/staged.ts')
  })

  it('ignores commit diff tabs (from commit history)', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-commit',
        filePath: '/repo/wt/src/commit.ts',
        relativePath: 'src/commit.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'commit'
      }
    ]
    const projection = mockProjection(true, 0)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-commit',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).not.toHaveBeenCalled()
  })

  it('ignores branch diff tabs', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-branch',
        filePath: '/repo/wt/src/branch.ts',
        relativePath: 'src/branch.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'branch'
      }
    ]
    const projection = mockProjection(true, 0)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-branch',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).not.toHaveBeenCalled()
  })

  it('scrolls to the matching row when the file is already visible', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    const setSelectedPath = vi.fn()
    const scrollToIndex = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'file-scroll',
        filePath: '/repo/wt/src/scroll.ts',
        relativePath: 'src/scroll.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'edit'
      }
    ]
    const projection = mockProjection(true, 7)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'file-scroll',
        openFiles,
        rowProjection: projection,
        setSelectedPath,
        virtualizer: { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>
      })
    )

    expect(setSelectedPath).toHaveBeenCalledWith('/repo/wt/src/scroll.ts')
    expect(scrollToIndex).toHaveBeenCalledWith(7, { align: 'auto' })
  })

  it('triggers pendingExplorerReveal when unstaged diff file is in a collapsed folder', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-collapsed',
        filePath: '/repo/wt/src/deep/nested.ts',
        relativePath: 'src/deep/nested.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'unstaged'
      }
    ]
    const projection = mockProjection(false)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-collapsed',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(projection.hasPath).toHaveBeenCalledWith('/repo/wt/src/deep/nested.ts')
    expect(setSelectedPath).not.toHaveBeenCalled()
    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingExplorerReveal: expect.objectContaining({
          worktreeId: 'wt-1',
          filePath: '/repo/wt/src/deep/nested.ts',
          flash: false
        })
      })
    )
  })

  it('does not create a reveal request for commit diff in a collapsed folder', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-commit-collapsed',
        filePath: '/repo/wt/src/commit-deep.ts',
        relativePath: 'src/commit-deep.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'commit'
      }
    ]
    const projection = mockProjection(false)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-commit-collapsed',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).not.toHaveBeenCalled()
    expect(projection.hasPath).not.toHaveBeenCalled()
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('does not create a reveal request for branch diff in a collapsed folder', () => {
    const setSelectedPath = vi.fn()
    const openFiles: OpenFile[] = [
      {
        id: 'diff-branch-collapsed',
        filePath: '/repo/wt/src/branch-deep.ts',
        relativePath: 'src/branch-deep.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource: 'branch'
      }
    ]
    const projection = mockProjection(false)

    renderHook(() =>
      useFileExplorerAutoReveal({
        ...defaultParams,
        activeFileId: 'diff-branch-collapsed',
        openFiles,
        rowProjection: projection,
        setSelectedPath
      })
    )

    expect(setSelectedPath).not.toHaveBeenCalled()
    expect(projection.hasPath).not.toHaveBeenCalled()
    expect(mockSetState).not.toHaveBeenCalled()
  })
})
