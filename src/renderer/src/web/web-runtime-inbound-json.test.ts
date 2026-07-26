import { describe, expect, it } from 'vitest'
import {
  isWebRuntimeJsonStructureCapacityError,
  parseWebRuntimeInboundJson
} from './web-runtime-inbound-json'

describe('web runtime inbound JSON admission', () => {
  it('accepts the exact structural-token limit and rejects one more', () => {
    const limits = { structuralTokens: 4, nestingDepth: 2 }

    expect(parseWebRuntimeInboundJson('[0,0,0]', limits)).toEqual([0, 0, 0])
    expect(() => parseWebRuntimeInboundJson('[0,0,0,0]', limits)).toThrow(
      'JSON structure exceeds 4 tokens'
    )
  })

  it('accepts the exact nesting limit and rejects one more', () => {
    const limits = { structuralTokens: 20, nestingDepth: 3 }

    expect(parseWebRuntimeInboundJson('[[[]]]', limits)).toEqual([[[]]])
    expect(() => parseWebRuntimeInboundJson('[[[[]]]]', limits)).toThrow(
      'JSON nesting exceeds 3 levels'
    )
  })

  it('identifies capacity failures separately from malformed JSON', () => {
    const capacityError = captureError(() =>
      parseWebRuntimeInboundJson('[0,0]', {
        structuralTokens: 2,
        nestingDepth: 2
      })
    )
    const syntaxError = captureError(() =>
      parseWebRuntimeInboundJson('[', {
        structuralTokens: 2,
        nestingDepth: 2
      })
    )

    expect(isWebRuntimeJsonStructureCapacityError(capacityError)).toBe(true)
    expect(isWebRuntimeJsonStructureCapacityError(syntaxError)).toBe(false)
  })
})

function captureError(run: () => void): unknown {
  try {
    run()
    return null
  } catch (error) {
    return error
  }
}
