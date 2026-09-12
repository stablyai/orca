import { describe, expect, it } from 'vitest'
import {
  structuralValuesEqual,
  structuralValuesEqualIgnoringUndefined
} from './structural-value-equality'

const comparators = [
  ['structuralValuesEqual', structuralValuesEqual],
  ['structuralValuesEqualIgnoringUndefined', structuralValuesEqualIgnoringUndefined]
] as const

describe.each(comparators)('%s', (_name, valuesEqual) => {
  it('compares primitives and identical references', () => {
    expect(valuesEqual('a', 'a')).toBe(true)
    expect(valuesEqual('a', 'b')).toBe(false)
    expect(valuesEqual(null, null)).toBe(true)
    expect(valuesEqual(null, {})).toBe(false)
    expect(valuesEqual(undefined, null)).toBe(false)
    const fn = (): void => {}
    expect(valuesEqual(fn, fn)).toBe(true)
    expect(valuesEqual(fn, (): void => {})).toBe(false)
  })

  it('walks arrays element-wise and never mixes them with records', () => {
    expect(valuesEqual([1, [2, { a: 'b' }]], [1, [2, { a: 'b' }]])).toBe(true)
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(valuesEqual([1, 2], [2, 1])).toBe(false)
    expect(valuesEqual([], {})).toBe(false)
    expect(valuesEqual({ 0: 1, length: 1 }, [1])).toBe(false)
  })

  it('walks nested plain records rebuilt by structured clone', () => {
    const record = { id: 'a', nested: { labels: ['one', 'two'], flags: { on: true } } }
    expect(valuesEqual(record, structuredClone(record))).toBe(true)
    expect(
      valuesEqual(record, { ...record, nested: { labels: ['one'], flags: { on: true } } })
    ).toBe(false)
  })

  it('walks null-prototype records like literals', () => {
    const nullProto: Record<string, unknown> = Object.create(null)
    nullProto.a = 1
    expect(valuesEqual(nullProto, { a: 1 })).toBe(true)
    expect(valuesEqual(nullProto, { a: 2 })).toBe(false)
  })

  it('falls back to reference equality for non-plain objects', () => {
    const date = new Date(0)
    expect(valuesEqual(date, date)).toBe(true)
    expect(valuesEqual(date, new Date(0))).toBe(false)
    expect(valuesEqual(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(false)
    expect(valuesEqual(new Set([1]), new Set([1]))).toBe(false)
    class Row {
      x = 1
    }
    expect(valuesEqual(new Row(), new Row())).toBe(false)
    expect(valuesEqual(new Row(), { x: 1 })).toBe(false)
  })

  it('ignores symbol keys', () => {
    const key = Symbol('marker')
    expect(valuesEqual({ [key]: 1, a: 1 }, { [key]: 2, a: 1 })).toBe(true)
  })
})

describe('structuralValuesEqual', () => {
  it('treats an absent key as different from a key holding undefined', () => {
    // Why: repo/project merges branch on `'key' in project`, so key presence is load-bearing.
    expect(structuralValuesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(structuralValuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false)
    expect(structuralValuesEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false)
    expect(structuralValuesEqual({ a: 1, b: undefined }, { a: 1, b: undefined })).toBe(true)
  })

  it('compares leaves with === so NaN is never equal and -0 matches 0', () => {
    expect(structuralValuesEqual({ a: Number.NaN }, { a: Number.NaN })).toBe(false)
    expect(structuralValuesEqual({ a: 0 }, { a: -0 })).toBe(true)
  })
})

describe('structuralValuesEqualIgnoringUndefined', () => {
  it('treats an absent key as equal to a key holding undefined', () => {
    // Why: locally built worktree rows carry explicit undefined fields the host omits.
    expect(structuralValuesEqualIgnoringUndefined({ a: 1 }, { a: 1, b: undefined })).toBe(true)
    expect(structuralValuesEqualIgnoringUndefined({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(
      structuralValuesEqualIgnoringUndefined({ a: 1, b: undefined }, { a: 1, c: undefined })
    ).toBe(true)
    expect(structuralValuesEqualIgnoringUndefined({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('compares leaves with Object.is so NaN is equal and -0 differs from 0', () => {
    expect(structuralValuesEqualIgnoringUndefined({ a: Number.NaN }, { a: Number.NaN })).toBe(true)
    expect(structuralValuesEqualIgnoringUndefined({ a: 0 }, { a: -0 })).toBe(false)
  })
})
