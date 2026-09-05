import { describe, expect, it } from 'vitest'
import { formatGenerationDuration, formatTokensPerSecondValue } from './agent-throughput-format'

describe('agent throughput formatting', () => {
  it('formats tokens per second by magnitude', () => {
    expect(formatTokensPerSecondValue(0)).toBe('0')
    expect(formatTokensPerSecondValue(Number.NaN)).toBe('0')
    expect(formatTokensPerSecondValue(0.44)).toBe('0.4')
    expect(formatTokensPerSecondValue(9.96)).toBe('10.0')
    expect(formatTokensPerSecondValue(68.4)).toBe('68')
    expect(formatTokensPerSecondValue(1234)).toBe('1.2k')
  })

  it('formats generation durations', () => {
    expect(formatGenerationDuration(4_210)).toBe('4.2s')
    expect(formatGenerationDuration(59_949)).toBe('59.9s')
    expect(formatGenerationDuration(125_000)).toBe('2m 05s')
    expect(formatGenerationDuration(119_400)).toBe('1m 59s')
    expect(formatGenerationDuration(119_999)).toBe('2m 00s')
    expect(formatGenerationDuration(-5)).toBe('0.0s')
  })
})
