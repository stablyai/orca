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
})
