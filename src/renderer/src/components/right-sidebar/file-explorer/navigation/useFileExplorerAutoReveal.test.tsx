// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { createFileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import type { TreeNode } from '../tree/file-explorer-types'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'

const ROOT = '/repo'
const FILE_PATH = '/repo/src/alpha/deep.ts'
const OPEN_FILES: OpenFile[] = [
  {
    id: 'file-deep',
    filePath: FILE_PATH,
    relativePath: 'src/alpha/deep.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  }
]
const srcRow: TreeNode = {
  name: 'src',
  path: '/repo/src',
  relativePath: 'src',
  isDirectory: true,
  depth: 0
}
const deepRow: TreeNode = {
  name: 'deep.ts',
  path: FILE_PATH,
  relativePath: 'src/alpha/deep.ts',
  isDirectory: false,
  depth: 2
}
const collapsedTree = createFileExplorerRowProjection([srcRow])
const expandedTree = createFileExplorerRowProjection([srcRow, deepRow])

type Props = {
  activeFileId: string | null
  worktreePath: string | null
  hasNameFilterQuery: boolean
  rowProjection: typeof collapsedTree
}

function renderAutoReveal(initialProps: Props) {
  const setSelectedPath = vi.fn()
  const hook = renderHook(
    (props: Props) => {
      const virtualizer = useVirtualizer<HTMLDivElement, Element>({
        count: props.rowProjection.getVisibleCount(),
        getScrollElement: () => null,
        estimateSize: () => 26
      })
      useFileExplorerAutoReveal({
        ...props,
        activeWorktreeId: 'wt-1',
        pendingExplorerReveal: null,
        openFiles: OPEN_FILES,
        setSelectedPath,
        virtualizer
      })
    },
    { initialProps }
  )
  return { ...hook, setSelectedPath }
}

function pendingRevealPath(): string | null {
  return useAppStore.getState().pendingExplorerReveal?.filePath ?? null
}

describe('useFileExplorerAutoReveal', () => {
  afterEach(() => {
    useAppStore.setState({ pendingExplorerReveal: null })
  })

  it('reveals the active file each time the unfiltered tree is shown after a hidden file switch', () => {
    const contents = {
      activeFileId: null,
      worktreePath: null,
      hasNameFilterQuery: false,
      rowProjection: collapsedTree
    }
    const { rerender, setSelectedPath } = renderAutoReveal(contents)
    rerender({ ...contents, activeFileId: 'file-deep' })
    expect(pendingRevealPath()).toBeNull()

    const shown = { ...contents, activeFileId: 'file-deep', worktreePath: ROOT }
    rerender(shown)
    expect(pendingRevealPath()).toBe(FILE_PATH)

    rerender({ ...shown, activeFileId: 'file-other', worktreePath: null })
    rerender({ ...shown, worktreePath: null })
    rerender({ ...shown, rowProjection: expandedTree })
    expect(setSelectedPath).toHaveBeenCalledExactlyOnceWith(FILE_PATH)
  })

  it('leaves a kept name filter alone when the tree is shown again', () => {
    const contents = {
      activeFileId: null,
      worktreePath: null,
      hasNameFilterQuery: true,
      rowProjection: collapsedTree
    }
    const { rerender, setSelectedPath } = renderAutoReveal(contents)
    rerender({ ...contents, activeFileId: 'file-deep' })

    // Neither a selection nor a pending reveal: a pending reveal makes the tree pane clear the filter.
    rerender({ ...contents, activeFileId: 'file-deep', worktreePath: ROOT })
    rerender({
      ...contents,
      activeFileId: 'file-deep',
      worktreePath: ROOT,
      rowProjection: expandedTree
    })
    expect(setSelectedPath).not.toHaveBeenCalled()
    expect(pendingRevealPath()).toBeNull()
  })
})
