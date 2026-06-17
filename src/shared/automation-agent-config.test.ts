import { describe, expect, it } from 'vitest'
import { normalizeAutomationAgentConfig } from './automation-agent-config'

describe('normalizeAutomationAgentConfig', () => {
  it('collapses an all-empty config to null', () => {
    expect(normalizeAutomationAgentConfig(null)).toBeNull()
    expect(normalizeAutomationAgentConfig({})).toBeNull()
    expect(normalizeAutomationAgentConfig({ launchArgs: '  ', model: '', env: {} })).toBeNull()
  })

  it('trims launchArgs and model', () => {
    expect(normalizeAutomationAgentConfig({ launchArgs: '  --x ', model: ' opus ' })).toEqual({
      launchArgs: '--x',
      model: 'opus'
    })
  })

  it('drops blank env keys and non-string values', () => {
    const result = normalizeAutomationAgentConfig({
      env: { GOOD: 'v', '  ': 'x', BAD: 123 as unknown as string }
    })
    expect(result).toEqual({ env: { GOOD: 'v' } })
  })

  it('omits absent fields rather than storing nulls', () => {
    const result = normalizeAutomationAgentConfig({ model: 'sonnet' })
    expect(result).toEqual({ model: 'sonnet' })
    expect(Object.prototype.hasOwnProperty.call(result, 'launchArgs')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(result, 'env')).toBe(false)
  })
})
