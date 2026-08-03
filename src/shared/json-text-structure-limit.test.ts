import { describe, expect, it } from 'vitest'
import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError,
  JsonTextStructureValidator
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

  it('preserves string and escape state across chunks', () => {
    const content = '{"value":"before\\\\\\\"[{:,}]after","rows":[{}]}'
    const validator = new JsonTextStructureValidator({
      structuralTokens: 9,
      nestingDepth: 3
    })
    for (let index = 0; index < content.length; index += 1) {
      validator.consume(content, index, index + 1)
    }

    expect(validator.usage()).toEqual({
      structuralTokens: 9,
      nestingDepth: 3
    })
  })
})
