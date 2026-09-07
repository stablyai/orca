import { describe, expect, it } from 'vitest'
import { compareFileNames, sortDirEntries } from './file-name-sort'

describe('compareFileNames', () => {
  it('sorts numeric name segments naturally instead of lexicographically', () => {
    const names = [
      '1 - item.txt',
      '100 - item.txt',
      '2 - item.txt',
      '200 - item.txt',
      '409 - item.txt',
      '41 - item.txt',
      '410 - item.txt',
      '9 - item.txt',
      '99 - item.txt'
    ]
    expect([...names].sort(compareFileNames)).toEqual([
      '1 - item.txt',
      '2 - item.txt',
      '9 - item.txt',
      '41 - item.txt',
      '99 - item.txt',
      '100 - item.txt',
      '200 - item.txt',
      '409 - item.txt',
      '410 - item.txt'
    ])
  })

  it('sorts embedded numbers naturally within alphabetical order', () => {
    expect(['b1.md', 'a10.md', 'a2.md', 'a1.md'].sort(compareFileNames)).toEqual([
      'a1.md',
      'a2.md',
      'a10.md',
      'b1.md'
    ])
  })

  it('breaks numeric-collation ties deterministically instead of readdir order', () => {
    // numeric collation ties "2" with "02"; the code-unit fallback keeps a total order.
    expect(['2.txt', '02.txt'].sort(compareFileNames)).toEqual(['02.txt', '2.txt'])
    expect(['02.txt', '2.txt'].sort(compareFileNames)).toEqual(['02.txt', '2.txt'])
    expect(compareFileNames('a.txt', 'a.txt')).toBe(0)
  })
})

describe('sortDirEntries', () => {
  it('keeps directories first, each group in natural order', () => {
    const entries = [
      { name: '10 - notes', isDirectory: false },
      { name: '2 - src', isDirectory: true },
      { name: '9 - docs.txt', isDirectory: false },
      { name: '10 - assets', isDirectory: true }
    ]
    expect(sortDirEntries(entries).map((e) => e.name)).toEqual([
      '2 - src',
      '10 - assets',
      '9 - docs.txt',
      '10 - notes'
    ])
  })
})
