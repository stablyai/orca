import { describe, expect, it } from 'vitest'
import { folderRelativePathToIncludeGlob } from './file-search-include-pattern'

describe('folderRelativePathToIncludeGlob', () => {
  it('normalizes separators and trailing slashes before appending the recursive glob', () => {
    expect(folderRelativePathToIncludeGlob('src\\components\\')).toBe('src/components/**')
    expect(folderRelativePathToIncludeGlob('/src//components///')).toBe('src/components/**')
  })

  it('escapes literal folder path characters that are meaningful to search globs', () => {
    expect(folderRelativePathToIncludeGlob('!secret')).toBe('\\!secret/**')
    expect(folderRelativePathToIncludeGlob('foo,bar')).toBe('foo\\,bar/**')
    expect(folderRelativePathToIncludeGlob('a[b]/{draft}?')).toBe('a\\[b\\]/\\{draft\\}\\?/**')
  })
})
