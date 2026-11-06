import { describe, expect, it } from 'vitest'
import { dirname, getRelativePathInsideRoot, joinPath } from './path'

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
