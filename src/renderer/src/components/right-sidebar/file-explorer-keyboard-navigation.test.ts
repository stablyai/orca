import { describe, expect, it, vi } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import {
  applyFileExplorerNavigation,
  resolveFileExplorerNavigationTarget
} from './file-explorer-keyboard-navigation'

function row(path: string, depth: number, isDirectory = false): TreeNode {
  return {
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    relativePath: path.replace('/repo/', ''),
    isDirectory,
    depth
  }
}

function makeProjection(rows: TreeNode[]) {
  return createFileExplorerRowProjection(rows)
}

const SAMPLE_ROWS = [
  row('/repo/src', 0, true),
  row('/repo/src/a.ts', 1),
  row('/repo/src/nested', 1, true),
  row('/repo/src/nested/b.ts', 2),
  row('/repo/root.ts', 0)
]

const isCollapsed = (): false => false
function isExpandedSet(paths: string[]): (path: string) => boolean {
  const set = new Set(paths)
  return (path) => set.has(path)
}

function keyboardEvent(key: string): KeyboardEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as KeyboardEvent
}

describe('resolveFileExplorerNavigationTarget', () => {
  describe('flat list movement', () => {
    const projection = makeProjection(SAMPLE_ROWS)

    it('moves to the next row on ArrowDown', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowDown',
          currentIndex: 0,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 1 })
    })

    it('moves to the previous row on ArrowUp', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowUp',
          currentIndex: 3,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 2 })
    })

    it('clamps ArrowDown to the last row', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowDown',
          currentIndex: 4,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 4 })
    })

    it('clamps ArrowUp to the first row', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowUp',
          currentIndex: 0,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 0 })
    })

    it('jumps to the first row on Home', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'Home',
          currentIndex: 3,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 0 })
    })

    it('jumps to the last row on End', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'End',
          currentIndex: 1,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 4 })
    })
  })

  describe('initial movement with no current row', () => {
    const projection = makeProjection(SAMPLE_ROWS)

    it('selects the first row on ArrowDown when nothing is focused', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowDown',
          currentIndex: null,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 0 })
    })

    it('selects the last row on ArrowUp when nothing is focused', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowUp',
          currentIndex: null,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 4 })
    })

    it('leaves ArrowLeft/Right unhandled when no current row is anchored', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowLeft',
          currentIndex: null,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'unhandled' })
    })
  })

  describe('arrow-right on a folder', () => {
    it('toggles to expand when the folder is collapsed', () => {
      const projection = makeProjection(SAMPLE_ROWS)
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowRight',
          currentIndex: 0,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'toggle-expand', currentIndex: 0, dirPath: '/repo/src' })
    })

    it('moves into the first child when the folder is already expanded', () => {
      const projection = makeProjection(SAMPLE_ROWS)
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowRight',
          currentIndex: 0,
          rowProjection: projection,
          total: 5,
          isExpanded: isExpandedSet(['/repo/src'])
        })
      ).toEqual({ type: 'move', targetIndex: 1 })
    })

    it('stays on the row when the target is a file', () => {
      const projection = makeProjection(SAMPLE_ROWS)
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowRight',
          currentIndex: 1,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 1 })
    })
  })

  describe('arrow-left on a folder', () => {
    it('toggles to collapse when the folder is expanded', () => {
      const projection = makeProjection(SAMPLE_ROWS)
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowLeft',
          currentIndex: 0,
          rowProjection: projection,
          total: 5,
          isExpanded: isExpandedSet(['/repo/src'])
        })
      ).toEqual({ type: 'toggle-collapse', currentIndex: 0, dirPath: '/repo/src' })
    })

    it('moves to the parent row when the folder is collapsed', () => {
      const projection = makeProjection(SAMPLE_ROWS)
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowLeft',
          currentIndex: 1,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'move', targetIndex: 0 })
    })

    it('no-ops at the top of the tree', () => {
      const projection = makeProjection(SAMPLE_ROWS)
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowLeft',
          currentIndex: 0,
          rowProjection: projection,
          total: 5,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'no-op' })
    })
  })

  describe('empty tree', () => {
    const projection = makeProjection([])

    it('returns no-op for any navigation key', () => {
      expect(
        resolveFileExplorerNavigationTarget({
          key: 'ArrowDown',
          currentIndex: null,
          rowProjection: projection,
          total: 0,
          isExpanded: isCollapsed
        })
      ).toEqual({ type: 'no-op' })
    })
  })
})

describe('applyFileExplorerNavigation', () => {
  it('does not persist folder toggles when directory toggling is disabled', () => {
    const projection = makeProjection(SAMPLE_ROWS)
    const event = keyboardEvent('ArrowLeft')
    const toggleDir = vi.fn()

    expect(
      applyFileExplorerNavigation(
        {
          rowProjection: projection,
          activeWorktreeId: 'wt-1',
          selectedNode: SAMPLE_ROWS[0],
          isExpanded: isExpandedSet(['/repo/src']),
          canToggleDirectories: false,
          findFocusedIndex: () => 0,
          handlers: {
            moveSelection: vi.fn(),
            toggleDir,
            scrollToIndex: vi.fn(),
            focusRowAtIndex: vi.fn()
          }
        },
        event
      )
    ).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(toggleDir).not.toHaveBeenCalled()
  })
})
