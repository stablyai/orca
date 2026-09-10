import { describe, expect, it } from 'vitest'
import { splitPathHeadForElision } from './palette-path-head-elision'

describe('splitPathHeadForElision', () => {
  it('keeps the last two segments as the tail', () => {
    expect(splitPathHeadForElision('/Users/me/projects/orca/proposals/create-button.html')).toEqual(
      {
        head: '/Users/me/projects/orca/',
        tail: 'proposals/create-button.html',
        tailRanges: []
      }
    )
  })

  it('leaves short or shallow paths whole', () => {
    expect(splitPathHeadForElision('src/app.ts')).toBeNull()
    expect(splitPathHeadForElision('a/b/c')).toBeNull()
    expect(splitPathHeadForElision('/tmp/orca-create-button/create-button.html')).toEqual({
      head: '/tmp/',
      tail: 'orca-create-button/create-button.html',
      tailRanges: []
    })
  })

  it('extends the tail back to the first matched segment and re-bases ranges', () => {
    const path = '/Users/me/projects/orca/new-create-button-design/proposals/create-button.html'
    const start = path.indexOf('create-butt')
    const split = splitPathHeadForElision(path, [{ start, end: start + 'create-butt'.length }])
    expect(split).toEqual({
      head: '/Users/me/projects/orca/',
      tail: 'new-create-button-design/proposals/create-button.html',
      tailRanges: [{ start: 4, end: 15 }]
    })
  })

  it('pulls a segment the match starts in fully into the tail', () => {
    const path = '/Users/me/projects/orca/deep/nested/file.ts'
    const split = splitPathHeadForElision(path, [{ start: 20, end: 30 }])
    expect(split?.head).toBe('/Users/me/projects/')
    expect(split?.tail).toBe('orca/deep/nested/file.ts')
    expect(split?.tailRanges).toEqual([{ start: 1, end: 11 }])
  })

  it('returns null when the match sits in the first segment', () => {
    const path = '/Users-long-prefix/me/projects/orca/deep/file.ts'
    expect(splitPathHeadForElision(path, [{ start: 1, end: 6 }])).toBeNull()
  })
})
