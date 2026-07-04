import { describe, expect, it } from 'vitest'
import {
  agentDotClass,
  clampPercent,
  formatGib,
  formatLoad,
  formatUptime
} from './host-status-format'

describe('formatGib', () => {
  it('formats bytes as gigabytes with one decimal', () => {
    expect(formatGib(16 * 1024 ** 3)).toBe('16.0')
    expect(formatGib(9.9 * 1024 ** 3)).toBe('9.9')
  })

  it('clamps negatives to zero', () => {
    expect(formatGib(-1)).toBe('0.0')
  })
})

describe('formatLoad', () => {
  it('formats with two decimals', () => {
    expect(formatLoad(1.2)).toBe('1.20')
    expect(formatLoad(0)).toBe('0.00')
  })
})

describe('formatUptime', () => {
  it('shows days and hours past a day', () => {
    expect(formatUptime(3 * 86_400 + 4 * 3_600)).toBe('3d 4h')
  })

  it('shows hours and minutes under a day', () => {
    expect(formatUptime(4 * 3_600 + 12 * 60)).toBe('4h 12m')
  })

  it('shows minutes only under an hour', () => {
    expect(formatUptime(12 * 60)).toBe('12m')
    expect(formatUptime(0)).toBe('0m')
  })
})

describe('agentDotClass', () => {
  it('maps each agent to a distinct color and null to muted', () => {
    expect(agentDotClass('claude')).toContain('orange')
    expect(agentDotClass('codex')).toContain('emerald')
    expect(agentDotClass(null)).toContain('muted-foreground')
  })
})

describe('clampPercent', () => {
  it('rounds and clamps to [0, 100]', () => {
    expect(clampPercent(62.4)).toBe(62)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})
