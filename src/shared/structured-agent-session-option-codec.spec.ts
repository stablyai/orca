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
    expect(encodeStructuredAgentSessionOptionValue('fastMode', 'true')).toBeNull()
    expect(decodeStructuredAgentSessionOptionValue('fastMode', 'TRUE')).toBeNull()
    expect(decodeStructuredAgentSessionOptionValue('fastMode', '1')).toBeNull()
  })

  it('passes existing string options through unchanged', () => {
    expect(encodeStructuredAgentSessionOptionValue('model', 'gpt-example')).toBe('gpt-example')
    expect(decodeStructuredAgentSessionOptionValue('effort', 'high')).toBe('high')
  })
})
