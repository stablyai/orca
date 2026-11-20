// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { createFileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import type { TreeNode } from '../tree/file-explorer-types'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'

const ROOT = '/repo'
const FILE_PATH = '/repo/src/alpha/deep.ts'
const OTHER_PATH = '/repo/src/beta/other.ts'
const OPEN_FILES: OpenFile[] = [
  {
    id: 'file-deep',
    filePath: FILE_PATH,
    relativePath: 'src/alpha/deep.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  },
  {
    id: 'file-other',
    filePath: OTHER_PATH,
    relativePath: 'src/beta/other.ts',
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
const otherRow: TreeNode = {
  name: 'other.ts',
  path: OTHER_PATH,
  relativePath: 'src/beta/other.ts',
  isDirectory: false,
  depth: 2
}
const collapsedTree = createFileExplorerRowProjection([srcRow])
const expandedTree = createFileExplorerRowProjection([srcRow, deepRow])
const otherFilteredTree = createFileExplorerRowProjection([otherRow])

type Props = {
  activeFileId: string | null
  worktreePath: string | null
  hasNameFilterQuery: boolean
  rowProjection: typeof collapsedTree
  pendingExplorerReveal?: { worktreeId: string; filePath: string; requestId: number }
}

function renderAutoReveal(initialProps: Props) {
  const setSelectedPath = vi.fn()
  const hook = renderHook(
    (props: Props) => {
      const [selectedPath, setSelection] = useState<string | null>(null)
      setSelectedPath.mockImplementation(setSelection)
      const virtualizer = useVirtualizer<HTMLDivElement, Element>({
        count: props.rowProjection.getVisibleCount(),
        getScrollElement: () => null,
        estimateSize: () => 26
      })
      useFileExplorerAutoReveal({
        ...props,
        activeWorktreeId: 'wt-1',
        pendingExplorerReveal: props.pendingExplorerReveal ?? null,
        openFiles: OPEN_FILES,
        selectedPath,
        setSelectedPath,
        virtualizer
      })
      return { selectedPath, selectRow: setSelection }
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

  it('reveals a file opened while the tree was hidden under a kept name filter once the filter is cleared', () => {
    const contents = {
      activeFileId: null,
      worktreePath: null,
      hasNameFilterQuery: true,
      rowProjection: collapsedTree
    }
    const filtered = {
      ...contents,
      activeFileId: 'file-deep',
      worktreePath: ROOT,
      rowProjection: expandedTree
    }
    const cleared = { ...filtered, hasNameFilterQuery: false, rowProjection: collapsedTree }

    const untouched = renderAutoReveal(contents)
    untouched.rerender({ ...contents, activeFileId: 'file-deep' })
    untouched.rerender(filtered)
    untouched.rerender(cleared)
    expect(pendingRevealPath()).toBe(FILE_PATH)
    untouched.unmount()
    useAppStore.setState({ pendingExplorerReveal: null })

    // A row the user picks under the filter after the tree is shown again is kept.
    const picked = renderAutoReveal(contents)
    picked.rerender({ ...contents, activeFileId: 'file-deep' })
    picked.rerender(filtered)
    act(() => picked.result.current.selectRow('/repo/src'))
    picked.rerender(cleared)
    expect(picked.result.current.selectedPath).toBe('/repo/src')
    expect(pendingRevealPath()).toBeNull()
  })

  it('expands the real tree to a file opened from name-filter rows once the filter is cleared', () => {
    const filtered = {
      activeFileId: 'file-deep',
      worktreePath: ROOT,
      hasNameFilterQuery: true,
      rowProjection: expandedTree
    }
    const { rerender, result } = renderAutoReveal({ ...filtered, activeFileId: null })

    rerender(filtered)
    expect(result.current.selectedPath).toBe(FILE_PATH)
    expect(pendingRevealPath()).toBeNull()

    rerender({ ...filtered, hasNameFilterQuery: false, rowProjection: collapsedTree })
    expect(pendingRevealPath()).toBe(FILE_PATH)
  })

  it('reveals a different file opened under a name filter without re-expanding an already-revealed collapsed folder', () => {
    const shown = {
      activeFileId: 'file-deep',
      worktreePath: ROOT,
      hasNameFilterQuery: false,
      rowProjection: expandedTree
    }
    const { rerender, setSelectedPath } = renderAutoReveal(shown)
    expect(setSelectedPath).toHaveBeenCalledTimes(1)

    // Collapsing the active file's folder, a Contents round trip and toggling a filter leave it collapsed.
    const collapsed = { ...shown, rowProjection: collapsedTree }
    rerender(collapsed)
    rerender({ ...collapsed, worktreePath: null })
    rerender(collapsed)
    rerender({ ...shown, hasNameFilterQuery: true })
    rerender(collapsed)
    expect(setSelectedPath).toHaveBeenCalledTimes(1)
    expect(pendingRevealPath()).toBeNull()

    // Switching to another file inside the name filter reveals that file once the filter is cleared.
    rerender({
      ...shown,
      activeFileId: 'file-other',
      hasNameFilterQuery: true,
      rowProjection: otherFilteredTree
    })
    expect(pendingRevealPath()).toBeNull()

    rerender({
      ...shown,
      activeFileId: 'file-other',
      hasNameFilterQuery: false,
      rowProjection: collapsedTree
    })
    expect(pendingRevealPath()).toBe(OTHER_PATH)
  })

  it('keeps a row the user selected under the name filter after the filter is cleared', () => {
    const filtered = {
      activeFileId: 'file-deep',
      worktreePath: ROOT,
      hasNameFilterQuery: true,
      rowProjection: expandedTree
    }
    const { rerender, result, setSelectedPath } = renderAutoReveal(filtered)
    expect(setSelectedPath).toHaveBeenCalledOnce()

    act(() => result.current.selectRow('/repo/src'))
    // Neither a narrower query hiding the file, a Contents round trip, nor matching again steals the row.
    rerender({ ...filtered, rowProjection: collapsedTree })
    rerender({ ...filtered, worktreePath: null })
    rerender(filtered)
    rerender({ ...filtered, hasNameFilterQuery: false, rowProjection: collapsedTree })
    expect(setSelectedPath).toHaveBeenCalledOnce()
    expect(result.current.selectedPath).toBe('/repo/src')
    expect(pendingRevealPath()).toBeNull()
  })

  it('lets a manual reveal that clears the name filter win over the active file', () => {
    const filtered = {
      activeFileId: 'file-deep',
      worktreePath: ROOT,
      hasNameFilterQuery: true,
      rowProjection: expandedTree
    }
    const { rerender, setSelectedPath } = renderAutoReveal(filtered)
    const cleared = { ...filtered, hasNameFilterQuery: false, rowProjection: collapsedTree }

    rerender({
      ...cleared,
      pendingExplorerReveal: { worktreeId: 'wt-1', filePath: OTHER_PATH, requestId: 1 }
    })
    rerender(cleared)
    expect(setSelectedPath).toHaveBeenCalledOnce()
    expect(pendingRevealPath()).toBeNull()
  })
})
