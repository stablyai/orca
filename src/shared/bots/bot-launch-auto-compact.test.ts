import { describe, expect, it } from 'vitest'
import { parseBotAutoCompactPercent } from './bot-launch'

describe('parseBotAutoCompactPercent', () => {
  it('reads whole percents in range, with or without a % sign', () => {
    expect(parseBotAutoCompactPercent('40')).toBe(40)
    expect(parseBotAutoCompactPercent(' 1 ')).toBe(1)
    expect(parseBotAutoCompactPercent('100%')).toBe(100)
  })

  it('refuses what Claude Code would ignore or misread', () => {
    for (const text of ['0', '101', '40.5', '-5', '1e2', '', 'forty', '0x20']) {
      expect(parseBotAutoCompactPercent(text)).toBeNull()
    }
  })
})
