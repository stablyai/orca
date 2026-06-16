import { describe, expect, it } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import {
  createSingleFileExplorerSelection,
  formatFileExplorerPathsForClipboard,
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

  it('formats copied nodes in the provided order', () => {
    const rows = [
      node('/repo/b.ts', 'b.ts'),
      node('/repo/a.ts', 'a.ts'),
      node('/repo/c.ts', 'c.ts')
    ]

    expect(formatFileExplorerPathsForClipboard(rows, 'absolute')).toBe(
      '/repo/b.ts\n/repo/a.ts\n/repo/c.ts'
    )
    expect(formatFileExplorerPathsForClipboard(rows, 'relative')).toBe('b.ts\na.ts\nc.ts')
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
})
