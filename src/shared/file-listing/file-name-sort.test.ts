import { describe, expect, it } from 'vitest'
import { sortDirEntries } from './file-name-sort'

describe('sortDirEntries', () => {
  it('sorts files before directories, naturally within each group', () => {
    const entries = [
      { name: 'dir2', isDirectory: true },
      { name: 'file10', isDirectory: false },
      { name: 'dir1', isDirectory: true },
      { name: 'file2', isDirectory: false }
    ]
    expect(sortDirEntries(entries).map((entry) => entry.name)).toEqual([
      'file2',
      'file10',
      'dir1',
      'dir2'
    ])
  })
})
