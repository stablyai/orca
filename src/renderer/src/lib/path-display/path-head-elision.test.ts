import { describe, expect, it } from 'vitest'
import { splitPathHeadForElision } from './path-head-elision'

describe('splitPathHeadForElision', () => {
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

  it('returns null when the match sits in the first segment', () => {
    const path = '/Users-long-prefix/me/projects/orca/deep/file.ts'
    expect(splitPathHeadForElision(path, [{ start: 1, end: 6 }])).toBeNull()
  })
})
