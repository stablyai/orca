import { afterEach, describe, expect, it, vi } from 'vitest'

const translateMock = vi.hoisted(() =>
  vi.fn((_key: string, fallback: string, values?: Record<string, string | number>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, String(value))
    }
    return result
  })
)

vi.mock('@/i18n/i18n', () => ({ translate: translateMock }))

import { formatResetCreditExpiry } from './reset-credit-expiry'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('formatResetCreditExpiry localization', () => {
  it('uses a semantic duration placeholder for singular and plural expiry copy', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00Z'))

    expect(formatResetCreditExpiry(Date.parse('2026-06-20T14:30:00Z'), 1)).toBe('Expires in 2h 30m')
    expect(formatResetCreditExpiry(Date.parse('2026-06-25T12:00:00Z'), 2)).toBe(
      'Next expires in 5d'
    )
    expect(translateMock).toHaveBeenNthCalledWith(
      1,
      'components.resetCreditExpiry.singleIn',
      'Expires in {{duration}}',
      { duration: '2h 30m' }
    )
    expect(translateMock).toHaveBeenNthCalledWith(
      2,
      'components.resetCreditExpiry.nextIn',
      'Next expires in {{duration}}',
      { duration: '5d' }
    )
  })
})
