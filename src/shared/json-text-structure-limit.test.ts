import { describe, expect, it } from 'vitest'
import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError
} from './json-text-structure-limit'

describe('JSON text structure admission', () => {
  it('preserves exact token and nesting boundaries', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
        structuralTokens: 7,
        nestingDepth: 3
      })
    ).not.toThrow()
  })

  it('rejects token and nesting limit +1', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
        structuralTokens: 6,
        nestingDepth: 3
      })
    ).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 6))
    expect(() =>
      assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
        structuralTokens: 7,
        nestingDepth: 2
      })
    ).toThrowError(new JsonTextStructureCapacityError('nestingDepth', 2))
  })

  it('does not count escaped structural characters inside strings', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"value":"[{\\\":,}]"}', {
        structuralTokens: 3,
        nestingDepth: 1
      })
    ).not.toThrow()
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])('handles a quote preceded by %i backslashes', (count) => {
    const content = `"${'\\'.repeat(count)}"[[]]`
    const check = () =>
      assertJsonTextStructureWithinLimits(content, {
        structuralTokens: 3,
        nestingDepth: 2
      })
    if (count % 2 === 0) {
      expect(check).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 3))
    } else {
      expect(check).not.toThrow()
    }
  })

  it('resumes counting after escaped quotes and long string values', () => {
    const content = JSON.stringify({ value: 'ordinary text [{,}] \\" '.repeat(10_000), next: [] })
    expect(() =>
      assertJsonTextStructureWithinLimits(content, { structuralTokens: 7, nestingDepth: 2 })
    ).not.toThrow()
    expect(() =>
      assertJsonTextStructureWithinLimits(content, { structuralTokens: 6, nestingDepth: 2 })
    ).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 6))
  })
})
