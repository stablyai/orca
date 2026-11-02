import { describe, expect, it } from 'vitest'
import { appendUniqueOpenFileIds } from './unsaved-close-queue'

describe('appendUniqueOpenFileIds', () => {
  it('appends only open file ids and skips duplicates', () => {
    const result = appendUniqueOpenFileIds(
      ['a'],
      ['a', 'b', 'missing', 'c', 'b'],
      new Set(['a', 'b', 'c'])
    )
    expect(result).toEqual(['a', 'b', 'c'])
  })
})
