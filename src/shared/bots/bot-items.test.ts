import { describe, expect, it } from 'vitest'
import { formatBotItemNumber } from './bot-items'

describe('formatBotItemNumber', () => {
  it('shows the number with a leading #', () => {
    expect(formatBotItemNumber(35)).toBe('#35')
    expect(formatBotItemNumber(1204)).toBe('#1204')
  })
})
