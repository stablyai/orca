import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatResetCountdown, formatResetDuration } from '../../../shared/rate-limit-reset-format'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from './window-label-formatter'

const language = vi.hoisted(() => ({ locale: 'en-US' }))
vi.mock('@/i18n/i18n', () => ({ getIntlLocale: () => language.locale }))
beforeEach(() => {
  language.locale = 'en-US'
})

const MIN = 60_000
const HOUR = 60 * MIN

describe('formatWindowLabel', () => {
  it('uses Russian units for the provider’s actual window duration', () => {
    language.locale = 'ru-RU'
    expect(formatWindowLabel(300)).toBe('5 ч')
    expect(formatWindowLabel(10080)).toMatch(/^1 нед\.?$/)
    expect(formatWindowLabel(4320)).toMatch(/^3 дн\.?$/)
    expect(formatWindowLabel(45)).toBe('45 мин')
  })
  it('returns "5h" for 300 minutes', () => {
    expect(formatWindowLabel(300)).toBe('5h')
  })

  it('returns "1h" for 60 minutes', () => {
    expect(formatWindowLabel(60)).toBe('1h')
  })

  it('returns "wk" for 10080 minutes (7 days)', () => {
    expect(formatWindowLabel(10080)).toBe('wk')
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

  it('returns "3d" for 4320 minutes (3 days)', () => {
    expect(formatWindowLabel(4320)).toBe('3d')
  })

  it('documents the formatter contract: 295 minutes stays raw ("295m")', () => {
    // MiniMax fetching snaps near-300-minute windows, not this formatter; pin canonical 5h output.
    expect(formatWindowLabel(295)).toBe('295m')
    expect(formatWindowLabel(300)).toBe('5h')
  })
})

describe('formatRateLimitWindowChipLabel', () => {
  // Codex chip/popup must share remaining duration for resetsAt, rather than fixed 5h versus countdown (#8378).
  it('shows remaining time when resetsAt is known (repro-8378)', () => {
    const now = 1_700_000_000_000
    const remainingMs = 2 * HOUR + 33 * MIN
    const window = { windowMinutes: 300, resetsAt: now + remainingMs }

    expect(formatRateLimitWindowChipLabel(window, now)).toBe('2h 33m')
    expect(formatRateLimitWindowChipLabel(window, now)).toBe(formatResetDuration(remainingMs))
    expect(formatResetCountdown(remainingMs)).toBe('Resets in 2h 33m')
  })

  it('falls back to fixed window size when resetsAt is null', () => {
    expect(formatRateLimitWindowChipLabel({ windowMinutes: 300, resetsAt: null })).toBe('5h')
    expect(formatRateLimitWindowChipLabel({ windowMinutes: 10080, resetsAt: null })).toBe('wk')
  })

  it('reports "now" when the reset timestamp has already passed', () => {
    const now = 1_700_000_000_000
    expect(formatRateLimitWindowChipLabel({ windowMinutes: 300, resetsAt: now - MIN }, now)).toBe(
      'now'
    )
  })
})
