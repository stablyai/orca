import { describe, expect, it } from 'vitest'
import { omitRecordKey, omitRecordKeys } from './record-key-omission'

describe('omitRecordKey', () => {
  it('returns the same record when the key is absent', () => {
    const record = { a: 1 }
    expect(omitRecordKey(record, 'b')).toBe(record)
  })

  it('returns a copy without the key when it is present', () => {
    const record = { a: 1, b: 2 }
    const next = omitRecordKey(record, 'b')
    expect(next).not.toBe(record)
    expect(next).toEqual({ a: 1 })
    expect(record).toEqual({ a: 1, b: 2 })
  })

  it('drops a key whose value is undefined', () => {
    const record = { a: undefined }
    expect(omitRecordKey(record, 'a')).toEqual({})
  })

  it('normalizes a missing record to an empty one, as spread-then-delete did', () => {
    expect(omitRecordKey(undefined, 'a')).toEqual({})
    expect(omitRecordKeys(undefined, ['a'])).toEqual({})
  })
})

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
})
