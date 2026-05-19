import { describe, expect, it } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import {
  countVisibleFileExplorerSelections,
  createSingleFileExplorerSelection,
  formatFileExplorerPathsForClipboard,
  getFileExplorerActionNodes,
  getFileExplorerSelectionMode,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths
} from './file-explorer-selection'

function node(path: string, relativePath = path): TreeNode {
  return {
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    relativePath,
    isDirectory: false,
    depth: 0
  }
}

describe('file explorer selection', () => {
  it('uses Ctrl for multi-selection on Windows and Linux', () => {
    expect(
      getFileExplorerSelectionMode({ ctrlKey: true, metaKey: false, shiftKey: false }, false)
    ).toBe('toggle')
    expect(
      getFileExplorerSelectionMode({ ctrlKey: true, metaKey: false, shiftKey: true }, false)
    ).toBe('additive-range')
  })

  it('uses Command for multi-selection on macOS', () => {
    expect(
      getFileExplorerSelectionMode({ ctrlKey: true, metaKey: false, shiftKey: false }, true)
    ).toBe('replace')
    expect(
      getFileExplorerSelectionMode({ ctrlKey: false, metaKey: true, shiftKey: false }, true)
    ).toBe('toggle')
  })

  it('selects a contiguous visible range from the anchor with Shift', () => {
    const current = createSingleFileExplorerSelection('/repo/a.ts')
    const next = updateFileExplorerSelection(
      current,
      ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      '/repo/c.ts',
      'range'
    )

    expect(Array.from(next.selectedPaths)).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'])
    expect(next.anchorPath).toBe('/repo/a.ts')
    expect(next.activePath).toBe('/repo/c.ts')
  })

  it('toggles a selected path without losing the remaining visible selection', () => {
    const current = updateFileExplorerSelection(
      createSingleFileExplorerSelection('/repo/a.ts'),
      ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      '/repo/c.ts',
      'range'
    )
    const next = updateFileExplorerSelection(
      current,
      ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      '/repo/b.ts',
      'toggle'
    )

    expect(Array.from(next.selectedPaths)).toEqual(['/repo/a.ts', '/repo/c.ts'])
    expect(next.activePath).toBe('/repo/a.ts')
  })

  it('copies selected nodes in visible tree order', () => {
    const rows = [
      node('/repo/b.ts', 'b.ts'),
      node('/repo/a.ts', 'a.ts'),
      node('/repo/c.ts', 'c.ts')
    ]
    const selectedPaths = new Set(['/repo/a.ts', '/repo/b.ts'])
    const actionNodes = getFileExplorerActionNodes(rows, selectedPaths, rows[0])

    expect(actionNodes.map((entry) => entry.path)).toEqual(['/repo/b.ts', '/repo/a.ts'])
    expect(formatFileExplorerPathsForClipboard(actionNodes, 'absolute')).toBe(
      '/repo/b.ts\n/repo/a.ts'
    )
    expect(formatFileExplorerPathsForClipboard(actionNodes, 'relative')).toBe('b.ts\na.ts')
  })

  it('copies only the context-clicked node when it is outside the current selection', () => {
    const rows = [node('/repo/a.ts'), node('/repo/b.ts')]
    const actionNodes = getFileExplorerActionNodes(rows, new Set(['/repo/a.ts']), rows[1])

    expect(actionNodes.map((entry) => entry.path)).toEqual(['/repo/b.ts'])
  })

  it('applies legacy path cleanup across the selected set', () => {
    const current = updateFileExplorerSelection(
      createSingleFileExplorerSelection('/repo/a.ts'),
      ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'],
      '/repo/c.ts',
      'range'
    )
    const next = updateFileExplorerSelectionPaths(current, (path) =>
      path === '/repo/b.ts' ? null : path
    )

    expect(Array.from(next.selectedPaths)).toEqual(['/repo/a.ts', '/repo/c.ts'])
    expect(next.activePath).toBe('/repo/c.ts')
    expect(next.anchorPath).toBe('/repo/a.ts')
  })

  it('does not scan rows for empty or single selection counts', () => {
    const rows = new Proxy([node('/repo/a.ts')], {
      get(target, prop, receiver) {
        if (prop === 'reduce') {
          throw new Error('unexpected row scan')
        }
        return Reflect.get(target, prop, receiver)
      }
    })

    expect(countVisibleFileExplorerSelections(rows, new Set())).toBe(0)
    expect(countVisibleFileExplorerSelections(rows, new Set(['/repo/a.ts']))).toBe(1)
  })
})
