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

  // The scan skips string bodies wholesale, so a backslash run that ends a string on an even
  // count — and one that escapes the quote on an odd count — must resolve the same way.
  it.each([
    ['{"value":"\\\\"}', 'even backslash run closes the string'],
    ['{"value":"\\\\\\\\"}', 'longer even backslash run closes the string'],
    ['{"value":"\\""}', 'escaped quote does not close the string'],
    ['{"a":"}","b":"]"}', 'structural characters inside adjacent strings'],
    ['{"emoji":"💥{[,:"}', 'astral-plane characters inside a string']
  ])('tracks string boundaries through %s', (content) => {
    expect(() =>
      assertJsonTextStructureWithinLimits(content, {
        structuralTokens: 1_000,
        nestingDepth: 8
      })
    ).not.toThrow()
  })

  it('stops scanning at an unterminated string instead of counting its contents', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"value":"[[[[[[[[[[', {
        structuralTokens: 2,
        nestingDepth: 1
      })
    ).not.toThrow()
  })

  it('scans an escape-dense string body in linear time', () => {
    // Why: a frame carrying a text file is one huge escaped string. Rescanning for the closing
    // quote once per escape is quadratic and stalls the receive loop for seconds at 4 MB.
    const body = `${'a'.repeat(63)}\\n`.repeat(66_000)
    const frame = `{"jsonrpc":"2.0","params":{"data":"${body}"}}`
    expect(frame.length).toBeGreaterThan(4_000_000)

    const startedAt = performance.now()
    assertJsonTextStructureWithinLimits(frame, {
      structuralTokens: 1_000_000,
      nestingDepth: 128
    })

    // Generous versus the ~1ms linear scan, but far under the ~2.5s the quadratic path takes.
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  it.each([
    ['{"a":"x\\\\","b":1}', 'a body ending in an escaped backslash'],
    ['{"a":"\\\\\\"}","b":2}', 'an escaped backslash before an escaped quote'],
    ['{"a":"\\"\\"\\"","b":3}', 'consecutive escaped quotes'],
    ['{"a":"\\n\\n\\n","b":4}', 'repeated short escapes']
  ])('finds the true string end past %s', (content) => {
    // Why: the scan advances a cursor past each escape and only rescans for the closing quote
    // once the cursor passes it — a stale quote index would end the string early and count
    // the remaining body as structure.
    expect(() =>
      assertJsonTextStructureWithinLimits(content, {
        structuralTokens: 6,
        nestingDepth: 4
      })
    ).not.toThrow()
  })

  it('rejects a deeply nested line before it becomes an object graph', () => {
    const depth = 1_024
    expect(() =>
      assertJsonTextStructureWithinLimits(`${'['.repeat(depth)}${']'.repeat(depth)}`, {
        structuralTokens: 1_000_000,
        nestingDepth: 128
      })
    ).toThrowError(new JsonTextStructureCapacityError('nestingDepth', 128))
  })
})
