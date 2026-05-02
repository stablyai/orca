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

  it('returns the original queue when no requested ids are provided', () => {
    const queue = ['a']
    expect(appendUniqueOpenFileIds(queue, [], new Set(['a']))).toEqual(['a'])
  })
})
