import { describe, expect, it } from 'vitest'
import { joinAbsolutePath, resolveTildePath } from './terminal-path-normalization'

describe('joinAbsolutePath', () => {
  it.each([
    ['/repo', '../sibling/readme.md', '/sibling/readme.md'],
    ['/repo/worktree', '../../sibling/readme.md', '/sibling/readme.md'],
    ['/repo/worktree', 'src/../../readme.md', '/repo/readme.md'],
    ['/repo/./worktree/..', '../sibling/readme.md', '/sibling/readme.md'],
    ['/repo', '../../../readme.md', '/readme.md'],
    ['/repo', '..', '/'],
    ['/', '../../readme.md', '/readme.md'],
    ['/', '', '/'],
    ['/', '/readme.md', '/readme.md'],
    [String.raw`c:\repo\worktree`, String.raw`..\sibling\readme.md`, 'C:/repo/sibling/readme.md'],
    ['C:/repo/worktree', '../../../readme.md', 'C:/readme.md'],
    ['C:/repo', '..', 'C:/'],
    ['C:/', '../readme.md', 'C:/readme.md'],
    ['C:/', '', 'C:/'],
    [
      String.raw`\\server\share\repo`,
      String.raw`..\sibling\readme.md`,
      '//server/share/sibling/readme.md'
    ],
    ['//server/share/repo', '../../../readme.md', '//server/share/readme.md'],
    ['//server/share/repo', '..', '//server/share'],
    ['//server/share', '../../readme.md', '//server/share/readme.md'],
    ['//server/share', '', '//server/share']
  ])('joins %j and %j without escaping its filesystem root', (base, relative, expected) => {
    expect(joinAbsolutePath(base, relative)).toBe(expected)
  })

  it('cannot resolve a relative base', () => {
    expect(joinAbsolutePath('repo', '../readme.md')).toBeNull()
  })
})

describe('resolveTildePath', () => {
  it('resolves parent segments against an inferred home', () => {
    expect(resolveTildePath('~/../shared/readme.md', '/home/me/repo')).toBe(
      '/home/shared/readme.md'
    )
  })

  it('retains the drive root when traversing beyond an explicit home', () => {
    expect(resolveTildePath('~/../../../readme.md', 'C:/repo', 'C:/Users/me')).toBe('C:/readme.md')
  })
})
