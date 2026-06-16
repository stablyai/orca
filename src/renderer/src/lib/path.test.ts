import { describe, expect, it } from 'vitest'
import { dirname, getRelativePathInsideRoot, joinPath } from './path'

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
})
