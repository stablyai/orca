import { describe, expect, it } from 'vitest'
import {
  getDotfileVisibleFileExplorerRows,
  isDotfileRelativePath,
  shouldIncludeFileExplorerEntry
} from './file-explorer-entries'

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

describe('getDotfileVisibleFileExplorerRows', () => {
  const rows = [
    { relativePath: 'src/index.ts' },
    { relativePath: '.env' },
    { relativePath: '.config/settings.json' },
    { relativePath: 'src/.cache/result.json' }
  ]

  it('returns the original row array when dotfiles are visible', () => {
    expect(getDotfileVisibleFileExplorerRows(rows, true)).toBe(rows)
  })

  it('filters dotfiles and descendants when dotfiles are hidden', () => {
    expect(getDotfileVisibleFileExplorerRows(rows, false).map((row) => row.relativePath)).toEqual([
      'src/index.ts'
    ])
  })
})
