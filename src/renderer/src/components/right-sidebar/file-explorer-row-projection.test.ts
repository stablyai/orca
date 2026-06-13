import { describe, expect, it } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'

function row(path: string, depth: number, isDirectory = false): TreeNode {
  return {
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    relativePath: path.replace('/repo/', ''),
    isDirectory,
    depth
  }
}

describe('file explorer row projection', () => {
  it('indexes visible rows by path and preserves tree order for selected paths', () => {
    const rows = [
      row('/repo/src', 0, true),
      row('/repo/src/a.ts', 1),
      row('/repo/src/nested', 1, true),
      row('/repo/src/nested/b.ts', 2),
      row('/repo/root.ts', 0)
    ]
    const projection = createFileExplorerRowProjection(rows)

    expect(projection.getVisibleCount()).toBe(5)
    expect(projection.getVisibleSlice(1, 2).map((entry) => entry.path)).toEqual([
      '/repo/src/a.ts',
      '/repo/src/nested'
    ])
    expect(projection.getRowAtIndex(2)?.path).toBe('/repo/src/nested')
    expect(projection.getRowByPath('/repo/src/a.ts')?.name).toBe('a.ts')
    expect(projection.getIndexByPath('/repo/src/nested/b.ts')).toBe(3)
    expect(projection.getIndexByPath('/repo/missing.ts')).toBeNull()
    expect(
      projection
        .getRowsByPaths(new Set(['/repo/root.ts', '/repo/src/a.ts']))
        .map((entry) => entry.path)
    ).toEqual(['/repo/src/a.ts', '/repo/root.ts'])
  })

  it('finds inline create positions from visible subtree boundaries', () => {
    const rows = [
      row('/repo/src', 0, true),
      row('/repo/src/a.ts', 1),
      row('/repo/src/nested', 1, true),
      row('/repo/src/nested/b.ts', 2),
      row('/repo/root.ts', 0)
    ]
    const projection = createFileExplorerRowProjection(rows)

    expect(projection.getInsertIndexAfterSubtree('/repo', '/repo')).toBe(5)
    expect(projection.getInsertIndexAfterSubtree('/repo/src', '/repo')).toBe(4)
    expect(projection.getInsertIndexAfterSubtree('/repo/src/nested', '/repo')).toBe(4)
    expect(projection.getInsertIndexAfterSubtree('/repo/missing', '/repo')).toBe(0)
  })

  it('places inline create after collapsed directory rows', () => {
    const projection = createFileExplorerRowProjection([
      row('/repo/src', 0, true),
      row('/repo/root.ts', 0)
    ])

    expect(projection.getInsertIndexAfterSubtree('/repo/src', '/repo')).toBe(1)
  })

  it('walks backward to find the immediate parent row in the visible list', () => {
    const projection = createFileExplorerRowProjection([
      row('/repo/src', 0, true),
      row('/repo/src/nested', 1, true),
      row('/repo/src/nested/deep', 2, true),
      row('/repo/src/nested/deep/x.ts', 3),
      row('/repo/root.ts', 0)
    ])

    expect(projection.getParentIndex(3)).toBe(2)
    expect(projection.getParentIndex(2)).toBe(1)
    expect(projection.getParentIndex(1)).toBe(0)
    // Why: the root directory itself is never a row, so its children have
    // no visible parent to walk up to.
    expect(projection.getParentIndex(0)).toBeNull()
    expect(projection.getParentIndex(4)).toBeNull()
    expect(projection.getParentIndex(99)).toBeNull()
  })

  it('finds the first child row only when the folder is expanded', () => {
    const projection = createFileExplorerRowProjection([
      row('/repo/src', 0, true),
      row('/repo/src/a.ts', 1),
      row('/repo/src/nested', 1, true),
      row('/repo/src/nested/b.ts', 2),
      row('/repo/root.ts', 0)
    ])

    expect(projection.getFirstChildIndex(0)).toBe(1)
    expect(projection.getFirstChildIndex(2)).toBe(3)
    // Why: files have no children; collapsed folders are not in the visible
    // list at all, so neither surface a first child.
    expect(projection.getFirstChildIndex(1)).toBeNull()
    expect(projection.getFirstChildIndex(4)).toBeNull()
    expect(projection.getFirstChildIndex(99)).toBeNull()
  })
})
