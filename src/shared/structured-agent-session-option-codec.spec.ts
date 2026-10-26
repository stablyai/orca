import { describe, expect, it } from 'vitest'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

describe('structured agent session option codec', () => {
  it('encodes and decodes explicit Fast mode booleans', () => {
    expect(encodeStructuredAgentSessionOptionValue('fastMode', true)).toBe('true')
    expect(encodeStructuredAgentSessionOptionValue('fastMode', false)).toBe('false')
    expect(decodeStructuredAgentSessionOptionValue('fastMode', 'true')).toBe(true)
    expect(decodeStructuredAgentSessionOptionValue('fastMode', 'false')).toBe(false)
  })

  it('rejects string booleans on the UI side and non-canonical strings on the wire side', () => {
    for (const value of ['true', 'false']) {
      expect(encodeStructuredAgentSessionOptionValue('fastMode', value)).toBeNull()
    }
    for (const value of ['TRUE', '1', 'False', ' true', 'false ', '', '0']) {
      expect(decodeStructuredAgentSessionOptionValue('fastMode', value)).toBeNull()
    }
  })

  it('preserves string options in both directions and rejects boolean values', () => {
    for (const [id, value] of [
      ['model', 'gpt-example'],
      ['effort', 'high'],
      ['serviceTier', 'flex']
    ] as const) {
      expect(encodeStructuredAgentSessionOptionValue(id, value)).toBe(value)
      expect(decodeStructuredAgentSessionOptionValue(id, value)).toBe(value)
      expect(encodeStructuredAgentSessionOptionValue(id, true)).toBeNull()
      expect(encodeStructuredAgentSessionOptionValue(id, false)).toBeNull()
    }
  })
})
