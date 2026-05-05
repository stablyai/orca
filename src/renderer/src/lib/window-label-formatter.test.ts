import { describe, expect, it } from 'vitest'
import { formatWindowLabel } from './window-label-formatter'

describe('formatWindowLabel', () => {
  it('returns "5h" for 300 minutes', () => {
    expect(formatWindowLabel(300)).toBe('5h')
  })

  it('returns "1h" for 60 minutes', () => {
    expect(formatWindowLabel(60)).toBe('1h')
  })

  it('returns "wk" for 10080 minutes (7 days)', () => {
    expect(formatWindowLabel(10080)).toBe('wk')
  })

  it('returns "1d" for 1440 minutes (1 day)', () => {
    expect(formatWindowLabel(1440)).toBe('1d')
  })

  it('returns "2h" for 120 minutes', () => {
    expect(formatWindowLabel(120)).toBe('2h')
  })

  it('returns "45m" for 45 minutes', () => {
    expect(formatWindowLabel(45)).toBe('45m')
  })

  it('returns "2wk" for 20160 minutes (14 days)', () => {
    expect(formatWindowLabel(20160)).toBe('2wk')
  })

  it('returns "30m" for 30 minutes', () => {
    expect(formatWindowLabel(30)).toBe('30m')
  })

  it('returns "3d" for 4320 minutes (3 days)', () => {
    expect(formatWindowLabel(4320)).toBe('3d')
  })
})
