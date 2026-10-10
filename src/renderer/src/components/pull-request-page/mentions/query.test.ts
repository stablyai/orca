import { describe, expect, it } from 'vitest'
import { findMentionQuery } from './query'

describe('findMentionQuery', () => {
  it('returns the @query immediately before the caret', () => {
    expect(findMentionQuery('hi @octo', 8)).toEqual({ atIndex: 3, query: 'octo' })
  })

  it('returns an empty query when the caret is right after @', () => {
    expect(findMentionQuery('hi @', 4)).toEqual({ atIndex: 3, query: '' })
  })

  it('returns null when there is no mention token at the caret', () => {
    expect(findMentionQuery('hello world', 11)).toBeNull()
    expect(findMentionQuery('email@host', 10)).toBeNull()
    expect(findMentionQuery('hi @octo more', 13)).toBeNull()
  })

  it('allows a mention after punctuation that starts a token', () => {
    expect(findMentionQuery('(@octo', 6)).toEqual({ atIndex: 1, query: 'octo' })
  })

  it('reads only the text before the caret', () => {
    expect(findMentionQuery('hi @octo trailing', 8)).toEqual({ atIndex: 3, query: 'octo' })
  })
})
