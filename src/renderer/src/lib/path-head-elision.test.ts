import { describe, expect, it } from 'vitest'
import { splitPathHeadForElision } from './path-head-elision'

describe('splitPathHeadForElision', () => {
  it('keeps the last two segments as the tail', () => {
    expect(splitPathHeadForElision('/Users/me/projects/orca/proposals/create-button.html')).toEqual(
      {
        head: '/Users/me/projects/orca',
        tail: '/proposals/create-button.html',
        tailRanges: []
      }
    )
  })

  it('supports Windows paths without changing their separators', () => {
    const path = 'C:\\Users\\me\\projects\\orca\\src\\renderer\\app.ts'
    const start = path.indexOf('src')

    expect(splitPathHeadForElision(path, [{ start, end: start + 3 }])).toEqual({
      head: 'C:\\Users\\me\\projects\\orca',
      tail: '\\src\\renderer\\app.ts',
      tailRanges: [{ start: 1, end: 4 }]
    })
  })

  it('keeps backslashes inside POSIX segment names', () => {
    expect(splitPathHeadForElision('/tmp/project/src/name\\with\\slashes.ts')).toEqual({
      head: '/tmp/project',
      tail: '/src/name\\with\\slashes.ts',
      tailRanges: []
    })
  })

  it('leaves short or shallow paths whole', () => {
    expect(splitPathHeadForElision('src/app.ts')).toBeNull()
    expect(splitPathHeadForElision('a/b/c')).toBeNull()
    expect(splitPathHeadForElision('/tmp/orca-create-button/create-button.html')).toEqual({
      head: '/tmp',
      tail: '/orca-create-button/create-button.html',
      tailRanges: []
    })
  })

  it('extends the tail back to the first matched segment and re-bases ranges', () => {
    const path = '/Users/me/projects/orca/new-create-button-design/proposals/create-button.html'
    const start = path.indexOf('create-butt')
    const split = splitPathHeadForElision(path, [{ start, end: start + 'create-butt'.length }])
    expect(split).toEqual({
      head: '/Users/me/projects/orca',
      tail: '/new-create-button-design/proposals/create-button.html',
      tailRanges: [{ start: 5, end: 16 }]
    })
  })

  it('pulls a segment the match starts in fully into the tail', () => {
    const path = '/Users/me/projects/orca/deep/nested/file.ts'
    const split = splitPathHeadForElision(path, [{ start: 20, end: 30 }])
    expect(split?.head).toBe('/Users/me/projects')
    expect(split?.tail).toBe('/orca/deep/nested/file.ts')
    expect(split?.tailRanges).toEqual([{ start: 2, end: 12 }])
  })

  it('returns null when the match sits in the first segment', () => {
    const path = '/Users-long-prefix/me/projects/orca/deep/file.ts'
    expect(splitPathHeadForElision(path, [{ start: 1, end: 6 }])).toBeNull()
  })
})
