import { describe, expect, it } from 'vitest'
import type { TreeNode } from './file-explorer-types'
import { getVisibleFileExplorerRows } from './useFileExplorerGitIgnoredRows'

function row(relativePath: string): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory: false,
    depth: 0
  }
}

describe('getVisibleFileExplorerRows', () => {
  it('keeps ignored files visible when the toggle is on', () => {
    const rows = [row('src/index.ts'), row('dist/bundle.js')]

    expect(getVisibleFileExplorerRows(rows, new Set(['dist']), true)).toBe(rows)
  })

  it('filters ignored files and descendants when the toggle is off', () => {
    const rows = [
      row('src/index.ts'),
      row('dist'),
      row('dist/bundle.js'),
      row('dist2/bundle.js'),
      row('.env')
    ]

    expect(
      getVisibleFileExplorerRows(rows, new Set(['dist', '.env']), false).map((r) => r.relativePath)
    ).toEqual(['src/index.ts', 'dist2/bundle.js'])
  })
})
