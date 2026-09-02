import { describe, expect, it } from 'vitest'
import { getProviderLetter } from './StatusBar'

describe('status bar provider labels', () => {
  it('distinguishes Kiro from Kimi in the narrow status bar', () => {
    expect(getProviderLetter('kimi')).toBe('K')
    expect(getProviderLetter('kiro')).toBe('Q')
  })
})
