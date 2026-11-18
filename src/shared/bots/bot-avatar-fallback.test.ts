import { describe, expect, it } from 'vitest'
import { botInitial } from './bot-avatar-fallback'

describe('botInitial', () => {
  it('takes the first character of the trimmed name', () => {
    expect(botInitial('  reviewer')).toBe('R')
    expect(botInitial('🦀 crab')).toBe('🦀')
    expect(botInitial('   ')).toBe('?')
  })
})
