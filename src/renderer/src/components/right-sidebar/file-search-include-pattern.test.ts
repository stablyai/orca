import { describe, expect, it } from 'vitest'
import {
  folderRelativePathToIncludeGlob,
  selectedExplorerFolderRelativePath
} from './file-search-include-pattern'

describe('folderRelativePathToIncludeGlob', () => {
  it('converts a relative folder path into a recursive include glob', () => {
    expect(folderRelativePathToIncludeGlob('src')).toBe('src/**')
    expect(folderRelativePathToIncludeGlob('src/components')).toBe('src/components/**')
  })

  it('normalizes separators and trailing slashes before appending the recursive glob', () => {
    expect(folderRelativePathToIncludeGlob('src\\components\\')).toBe('src/components/**')
    expect(folderRelativePathToIncludeGlob('/src//components///')).toBe('src/components/**')
  })

  it('returns an empty pattern for the repository root', () => {
    expect(folderRelativePathToIncludeGlob('')).toBe('')
    expect(folderRelativePathToIncludeGlob('/')).toBe('')
  })

  it('escapes literal folder path characters that are meaningful to search globs', () => {
    expect(folderRelativePathToIncludeGlob('!secret')).toBe('\\!secret/**')
    expect(folderRelativePathToIncludeGlob('foo,bar')).toBe('foo\\,bar/**')
    expect(folderRelativePathToIncludeGlob('a[b]/{draft}?')).toBe('a\\[b\\]/\\{draft\\}\\?/**')
  })
})

describe('selectedExplorerFolderRelativePath', () => {
  it('reads the selected folder path from the explorer shell', () => {
    const shell = {
      getAttribute: (name: string) => (name === 'data-selected-folder-relative-path' ? 'src' : null)
    } as Element
    const child = {
      closest: (selector: string) => (selector === '[data-orca-explorer-shell]' ? shell : null)
    } as Element

    expect(selectedExplorerFolderRelativePath(child)).toBe('src')
  })

  it('treats the repository root empty path as a selected folder', () => {
    const shell = {
      getAttribute: (name: string) => (name === 'data-selected-folder-relative-path' ? '' : null)
    } as Element
    const child = {
      closest: (selector: string) => (selector === '[data-orca-explorer-shell]' ? shell : null)
    } as Element

    expect(selectedExplorerFolderRelativePath(child)).toBe('')
  })

  it('returns null when focus is outside the explorer or no folder is selected', () => {
    const outside = {
      closest: () => null
    } as unknown as Element
    const shellWithoutFolder = {
      getAttribute: () => null
    } as unknown as Element
    const child = {
      closest: () => shellWithoutFolder
    } as unknown as Element

    expect(selectedExplorerFolderRelativePath(outside)).toBeNull()
    expect(selectedExplorerFolderRelativePath(child)).toBeNull()
  })
})
