import { describe, expect, it } from 'vitest'
import { getProviderDisplayName } from './usage-provider-windows'

describe('getProviderDisplayName', () => {
  it('returns the DeepSeek brand name', () => {
    expect(getProviderDisplayName('deepseek')).toBe('DeepSeek')
  })
})
