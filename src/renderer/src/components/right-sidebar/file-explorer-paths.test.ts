import { describe, expect, it } from 'vitest'
import { getRevealAncestorDirs, isPathEqualOrDescendant } from './file-explorer-paths'

describe('file explorer path helpers', () => {
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

  it('builds reveal ancestors for Windows drive-root worktrees', () => {
    expect(getRevealAncestorDirs('C:\\', 'c:\\repo\\src\\app.ts')).toEqual([
      'C:\\repo',
      'C:\\repo\\src'
    ])
  })

  it.each(['/repo', '/ssh/repo\\root'])(
    'reveals POSIX literal-backslash names without inventing directories under %s',
    (root) => {
      expect(getRevealAncestorDirs(root, `${root}/a\\b.txt`)).toEqual([])
      expect(getRevealAncestorDirs(root, `${root}/a/b.txt`)).toEqual([`${root}/a`])
      expect(getRevealAncestorDirs(root, `${root}/a\\b/c\\d.txt`)).toEqual([`${root}/a\\b`])
    }
  )

  it('reveals Windows UNC paths with native separators', () => {
    expect(
      getRevealAncestorDirs('\\\\server\\share\\repo', '\\\\server\\share\\repo\\a\\b.txt')
    ).toEqual(['\\\\server\\share\\repo\\a'])
  })
})
