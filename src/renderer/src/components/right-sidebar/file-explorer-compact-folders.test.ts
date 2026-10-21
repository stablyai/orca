import { describe, expect, it } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import {
  compactFileExplorerRows,
  type FileExplorerCompactedRows
} from './file-explorer-compact-folders'

function row(relativePath: string, isDirectory: boolean): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: relativePath.split('/').length - 1
  }
}

/** Each row as drawn: two spaces per indentation level, then its label. */
function drawn({ rows, layout }: FileExplorerCompactedRows): string[] {
  return rows.map((node, index) => {
    const folders = [...(layout.compactedAncestorsByIndex.get(index) ?? []), node]
    return `${'  '.repeat(layout.depths[index])}${folders.map((folder) => folder.name).join('/')}`
  })
}

const noPinnedRows = (): boolean => false

describe('compactFileExplorerRows', () => {
  it('folds a chain of single-folder rows into the row of its deepest folder', () => {
    const result = compactFileExplorerRows(
      [
        row('src', true),
        row('src/main', true),
        row('src/main/java', true),
        row('src/main/java/com', true),
        row('src/main/java/com/App.java', false),
        row('src/main/java/com/Util.java', false),
        row('README.md', false)
      ],
      noPinnedRows
    )

    expect(drawn(result)).toEqual(['src/main/java/com', '  App.java', '  Util.java', 'README.md'])
    expect(result.rows[0].path).toBe('/repo/src/main/java/com')
  })

  it('maps every folded folder to the row that now shows it', () => {
    const result = compactFileExplorerRows(
      [row('a', true), row('a/b', true), row('a/b/c', true), row('a/b/c/x.ts', false)],
      noPinnedRows
    )

    expect(result.rowsByPath.get('/repo/a')?.path).toBe('/repo/a/b/c')
    expect(result.rowsByPath.get('/repo/a/b')?.path).toBe('/repo/a/b/c')
    expect(result.rowsByPath.get('/repo/a/b/c')?.path).toBe('/repo/a/b/c')
    expect(result.rowsByPath.get('/repo/a/b/c/x.ts')?.path).toBe('/repo/a/b/c/x.ts')
  })

  it('stops at a folder with two visible children', () => {
    const result = compactFileExplorerRows(
      [
        row('a', true),
        row('a/b', true),
        row('a/b/c', true),
        row('a/b/c/x.ts', false),
        row('a/b/d', true)
      ],
      noPinnedRows
    )

    expect(drawn(result)).toEqual(['a/b', '  c', '    x.ts', '  d'])
  })

  it('keeps a folder whose only child is a file on its own row', () => {
    const result = compactFileExplorerRows(
      [row('a', true), row('a/x.ts', false), row('b.ts', false)],
      noPinnedRows
    )

    expect(drawn(result)).toEqual(['a', '  x.ts', 'b.ts'])
    expect(result.layout.compactedAncestorsByIndex.size).toBe(0)
  })

  it('folds an expanded folder into its only child even when that child is collapsed', () => {
    // a is expanded and lists only b; b is collapsed, so it has no rows of its own.
    const result = compactFileExplorerRows([row('a', true), row('a/b', true)], noPinnedRows)

    expect(drawn(result)).toEqual(['a/b'])
  })

  it('leaves a folder without visible children alone, whether collapsed, empty or still loading', () => {
    const result = compactFileExplorerRows(
      [row('a', true), row('b', true), row('c.ts', false)],
      noPinnedRows
    )

    expect(drawn(result)).toEqual(['a', 'b', 'c.ts'])
  })

  it('ends the chain at a folder the caller keeps on its own row', () => {
    const result = compactFileExplorerRows(
      [row('a', true), row('a/b', true), row('a/b/c', true), row('a/b/c/x.ts', false)],
      (folder) => folder.path === '/repo/a/b'
    )

    expect(drawn(result)).toEqual(['a/b', '  c', '    x.ts'])
  })

  it('indents rows below folded rows one level per drawn parent', () => {
    const result = compactFileExplorerRows(
      [
        row('a', true),
        row('a/b', true),
        row('a/b/c', true),
        row('a/b/c/d', true),
        row('a/b/c/d/e', true),
        row('a/b/c/d/e/x.ts', false),
        row('a/b/c/y.ts', false),
        row('z.ts', false)
      ],
      noPinnedRows
    )

    expect(drawn(result)).toEqual(['a/b/c', '  d/e', '    x.ts', '  y.ts', 'z.ts'])
  })

  it('keeps the indentation of a scoped root whose rows start below depth 0', () => {
    const scopedRow = (relativePath: string, isDirectory: boolean): TreeNode =>
      row(`packages/app/${relativePath}`, isDirectory)
    const result = compactFileExplorerRows(
      [
        scopedRow('src', true),
        scopedRow('src/lib', true),
        scopedRow('src/lib/index.ts', false),
        scopedRow('package.json', false)
      ],
      noPinnedRows
    )

    expect(result.layout.depths).toEqual([2, 3, 2])
    expect(result.rows.map((node) => node.name)).toEqual(['lib', 'index.ts', 'package.json'])
  })
})
