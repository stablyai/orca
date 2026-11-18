import { describe, expect, it } from 'vitest'
import { orderDirEntriesForSortMode, type FileExplorerSortMode } from './file-name-sort'

describe('orderDirEntriesForSortMode', () => {
  const foldersFirstListing = [
    { name: 'src', isDirectory: true },
    { name: 'test10', isDirectory: true },
    { name: 'README.md', isDirectory: false },
    { name: 'test2.ts', isDirectory: false }
  ]

  it.each<[FileExplorerSortMode, string[]]>([
    ['folders-first', ['src', 'test10', 'README.md', 'test2.ts']],
    ['files-first', ['README.md', 'test2.ts', 'src', 'test10']],
    ['mixed', ['README.md', 'src', 'test2.ts', 'test10']]
  ])('orders a folders-first listing for %s', (mode, expected) => {
    expect(
      orderDirEntriesForSortMode(foldersFirstListing, mode).map((entry) => entry.name)
    ).toEqual(expected)
  })
})
