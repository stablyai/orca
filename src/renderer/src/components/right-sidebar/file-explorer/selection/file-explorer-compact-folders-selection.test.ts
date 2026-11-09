import { describe, expect, it } from 'vitest'
import type { TreeNode } from '../tree/file-explorer-types'
import { createCompactFileExplorerRowProjection } from '../tree/file-explorer-compact-folders'
import { resolveFileExplorerNavigationTarget } from './file-explorer-keyboard-navigation'
import {
  createSingleFileExplorerSelection,
  resolveFileExplorerSelectionRows,
  updateFileExplorerSelection
} from './file-explorer-selection'

function row(path: string, depth: number, isDirectory = false): TreeNode {
  return {
    name: path.split('/').at(-1) ?? path,
    path,
    relativePath: path.replace('/repo/', ''),
    isDirectory,
    depth
  }
}

// Drawn as: `src/main/java` (expanded), `  App.java`, `  util`, `    Strings.java`, `build.gradle`.
function javaProjection() {
  return createCompactFileExplorerRowProjection(
    [
      row('/repo/src', 0, true),
      row('/repo/src/main', 1, true),
      row('/repo/src/main/java', 2, true),
      row('/repo/src/main/java/App.java', 3),
      row('/repo/src/main/java/util', 3, true),
      row('/repo/src/main/java/util/Strings.java', 4),
      row('/repo/build.gradle', 0)
    ],
    () => false
  )
}

const allExpanded = (): boolean => true

describe('keyboard navigation with compact folders', () => {
  it('collapses the deepest folder of an expanded compact row on ArrowLeft', () => {
    expect(
      resolveFileExplorerNavigationTarget({
        key: 'ArrowLeft',
        currentIndex: 0,
        rowProjection: javaProjection(),
        total: 5,
        isExpanded: allExpanded
      })
    ).toEqual({ type: 'toggle-collapse', currentIndex: 0, dirPath: '/repo/src/main/java' })
  })

  it('moves between a compact row and its children by drawn depth', () => {
    const projection = javaProjection()
    const navigate = (key: 'ArrowLeft' | 'ArrowRight', currentIndex: number) =>
      resolveFileExplorerNavigationTarget({
        key,
        currentIndex,
        rowProjection: projection,
        total: 5,
        isExpanded: allExpanded
      })

    expect(navigate('ArrowRight', 0)).toEqual({ type: 'move', targetIndex: 1 })
    expect(navigate('ArrowLeft', 1)).toEqual({ type: 'move', targetIndex: 0 })
  })
})

describe('selection with compact folders', () => {
  it('resolves a folded folder to the row that shows it', () => {
    const projection = javaProjection()

    expect(projection.getRowByPath('/repo/src')?.path).toBe('/repo/src/main/java')
    expect(projection.getIndexByPath('/repo/src/main')).toBe(0)
  })

  it('counts and returns a folded row once however many of its folders are selected', () => {
    const projection = javaProjection()
    const selected = new Set(['/repo/src', '/repo/src/main/java', '/repo/build.gradle'])

    expect(projection.countVisiblePaths(selected)).toBe(2)
    expect(projection.getRowsByPaths(selected).map((entry) => entry.path)).toEqual([
      '/repo/src/main/java',
      '/repo/build.gradle'
    ])
  })

  it('merges a folded folder and the row it folds into into one selected path', () => {
    const rowPaths = new Map([
      ['/repo/src', '/repo/src/main'],
      ['/repo/src/main', '/repo/src/main'],
      ['/repo/build.gradle', '/repo/build.gradle']
    ])
    const current = updateFileExplorerSelection(
      createSingleFileExplorerSelection('/repo/src'),
      ['/repo/src', '/repo/src/main', '/repo/build.gradle'],
      '/repo/build.gradle',
      'range'
    )

    const next = resolveFileExplorerSelectionRows(current, (path) => rowPaths.get(path))

    expect(Array.from(next.selectedPaths)).toEqual(['/repo/src/main', '/repo/build.gradle'])
    expect(next.anchorPath).toBe('/repo/src/main')
    expect(next.activePath).toBe('/repo/build.gradle')
  })
})
