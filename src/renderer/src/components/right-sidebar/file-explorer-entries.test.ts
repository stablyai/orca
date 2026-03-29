import { describe, expect, it } from 'vitest'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'

describe('shouldIncludeFileExplorerEntry', () => {
  it('keeps hidden files and folders visible in the explorer', () => {
    expect(
      shouldIncludeFileExplorerEntry({
        name: '.env',
        isDirectory: false,
        isSymlink: false
      })
    ).toBe(true)

    expect(
      shouldIncludeFileExplorerEntry({
        name: '.config',
        isDirectory: true,
        isSymlink: false
      })
    ).toBe(true)
  })

  it('still excludes internal and bulky directories', () => {
    expect(
      shouldIncludeFileExplorerEntry({
        name: '.git',
        isDirectory: true,
        isSymlink: false
      })
    ).toBe(false)

    expect(
      shouldIncludeFileExplorerEntry({
        name: 'node_modules',
        isDirectory: true,
        isSymlink: false
      })
    ).toBe(false)
  })
})
