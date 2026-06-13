import { describe, expect, it } from 'vitest'
import { isDotfileRelativePath, shouldIncludeFileExplorerEntry } from './file-explorer-entries'

describe('shouldIncludeFileExplorerEntry', () => {
  it('keeps dotfiles loadable so visibility can be toggled client-side', () => {
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

describe('isDotfileRelativePath', () => {
  it('matches dotfiles and descendants of dot folders across path separators', () => {
    expect(isDotfileRelativePath('.env')).toBe(true)
    expect(isDotfileRelativePath('.config/settings.json')).toBe(true)
    expect(isDotfileRelativePath('src/.cache/result.json')).toBe(true)
    expect(isDotfileRelativePath('src\\.cache\\result.json')).toBe(true)
  })

  it('does not match ordinary paths', () => {
    expect(isDotfileRelativePath('src/index.ts')).toBe(false)
    expect(isDotfileRelativePath('config/settings.json')).toBe(false)
  })
})
