import { describe, expect, it } from 'vitest'
import { dirname, getRelativePathInsideRoot, joinPath } from './path'

describe('dirname', () => {
  it('keeps the POSIX root when resolving a file in the filesystem root', () => {
    expect(dirname('/README.md')).toBe('/')
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
  it('matches a decomposed root against a composed file path', () => {
    // Case-only comparison missed macOS NFD roots containing NFC files (#10832).
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
