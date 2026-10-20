import { describe, expect, it } from 'vitest'
import { basename, dirname, getRelativePathInsideRoot, joinPath } from './path'

describe('basename', () => {
  it('takes the last segment of POSIX, Windows and mixed-separator paths', () => {
    expect(basename('/a/b/repo')).toBe('repo')
    expect(basename('C:\\work\\repo')).toBe('repo')
    expect(basename('C:/work/repo')).toBe('repo')
  })

  it('ignores a trailing separator', () => {
    expect(basename('/a/b/repo/')).toBe('repo')
    expect(basename('C:\\work\\repo\\')).toBe('repo')
  })

  it('returns an empty name for a root or empty path', () => {
    // The dialogs fall back to the full path so a root still reads as itself.
    expect(basename('/')).toBe('')
    expect(basename('')).toBe('')
  })
})

describe('dirname', () => {
  it('keeps the POSIX root when resolving a file in the filesystem root', () => {
    expect(dirname('/README.md')).toBe('/')
  })

  it('keeps the POSIX root when given the root path directly', () => {
    expect(dirname('/')).toBe('/')
  })

  it('keeps the Windows drive root when resolving a file in the drive root', () => {
    expect(dirname('C:\\README.md')).toBe('C:')
  })
})

describe('joinPath', () => {
  it('joins onto a Windows drive root returned by dirname', () => {
    expect(joinPath(dirname('C:\\README.md'), 'image.png')).toBe('C:/image.png')
  })
})

describe('getRelativePathInsideRoot', () => {
  it('matches Windows drive paths case-insensitively', () => {
    expect(getRelativePathInsideRoot('C:\\Repo\\Docs\\Plan.md', 'c:\\repo')).toBe('Docs/Plan.md')
  })

  it('matches Windows drive-root paths without adding an extra separator', () => {
    expect(getRelativePathInsideRoot('C:\\Repo\\Docs\\Plan.md', 'c:\\')).toBe('Repo/Docs/Plan.md')
  })

  it('matches Windows UNC paths case-insensitively', () => {
    expect(
      getRelativePathInsideRoot('\\\\Server\\Share\\Repo\\Docs\\Plan.md', '\\\\server\\share\\repo')
    ).toBe('Docs/Plan.md')
  })

  it('keeps POSIX path checks case-sensitive', () => {
    expect(getRelativePathInsideRoot('/Repo/Docs/Plan.md', '/repo')).toBeNull()
  })

  it('matches a decomposed root against a composed file path', () => {
    // Regression for #10832: a local copy of this comparison folded case but not
    // Unicode, so macOS NFD roots missed their own NFC files entirely.
    const composed = '/Users/ada/프로젝트'
    expect(getRelativePathInsideRoot(`${composed}/Docs/Plan.md`, composed.normalize('NFD'))).toBe(
      'Docs/Plan.md'
    )
  })
})

it.each(['/native/repo\\root', '/ssh/repo\\root'])(
  'joins POSIX names without merging literal-backslash identities under %s',
  (root) => {
    expect(joinPath(root, 'a\\b.txt')).toBe(`${root}/a\\b.txt`)
    expect(joinPath(root, 'a/b.txt')).toBe(`${root}/a/b.txt`)
  }
)
