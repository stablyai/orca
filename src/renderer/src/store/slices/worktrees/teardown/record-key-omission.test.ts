import { describe, expect, it } from 'vitest'
import { omitRecordKeys } from './record-key-omission'

describe('omitRecordKeys', () => {
  it('returns the same record when none of the keys are present', () => {
    const record = { a: 1 }
    expect(omitRecordKeys(record, ['b', 'c'])).toBe(record)
    expect(omitRecordKeys(record, new Set<string>())).toBe(record)
  })

  it('copies once and drops every present key', () => {
    const record = { a: 1, b: 2, c: 3 }
    const next = omitRecordKeys(record, new Set(['a', 'c', 'missing']))
    expect(next).not.toBe(record)
    expect(next).toEqual({ b: 2 })
    expect(record).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('drops a key whose value is undefined', () => {
    expect(omitRecordKeys({ a: undefined }, ['a'])).toEqual({})
  })

  it('normalizes a missing record to an empty one, as spread-then-delete did', () => {
    expect(omitRecordKeys(undefined, ['a'])).toEqual({})
  })
})
