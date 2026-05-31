import { describe, expect, it } from 'vitest'
import {
  getRevealAncestorDirs,
  isPathEqualOrDescendant,
  normalizeAbsolutePath
} from './file-explorer-paths'

describe('file explorer path helpers', () => {
  it('preserves UNC roots while normalizing separators', () => {
    expect(normalizeAbsolutePath('\\\\Server\\Share\\Repo\\')).toBe('//Server/Share/Repo')
  })

  it('matches Windows drive paths case-insensitively with segment boundaries', () => {
    expect(isPathEqualOrDescendant('c:\\repo\\src\\a.ts', 'C:\\Repo')).toBe(true)
    expect(isPathEqualOrDescendant('C:\\Repository\\src\\a.ts', 'C:\\Repo')).toBe(false)
  })

  it('matches Windows UNC paths case-insensitively with segment boundaries', () => {
    expect(isPathEqualOrDescendant('\\\\server\\share\\repo\\src', '\\\\Server\\Share\\Repo')).toBe(
      true
    )
    expect(
      isPathEqualOrDescendant('\\\\server\\share\\repository\\src', '\\\\Server\\Share\\Repo')
    ).toBe(false)
  })

  it('keeps POSIX path comparisons case-sensitive', () => {
    expect(isPathEqualOrDescendant('/Repo/src/a.ts', '/repo')).toBe(false)
  })

  it('builds reveal ancestors from the worktree casing and target relative casing', () => {
    expect(getRevealAncestorDirs('C:\\Repo', 'c:\\repo\\Src\\Nested\\File.ts')).toEqual([
      'C:\\Repo\\Src',
      'C:\\Repo\\Src\\Nested'
    ])
    expect(getRevealAncestorDirs('/repo', '/Repo/Src/File.ts')).toBeNull()
  })
})
