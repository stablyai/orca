import { describe, expect, it } from 'vitest'
import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError
} from './json-text-structure-limit'

describe('JSON text structure admission', () => {
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
