import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIntlLocale } = vi.hoisted(() => ({ mockIntlLocale: { value: 'en' } }))

vi.mock('./i18n', () => ({ getIntlLocale: () => mockIntlLocale.value }))

import { getUiRelativeTimeFormatter } from './relative-time-format'

beforeEach(() => {
  mockIntlLocale.value = 'en'
})

describe('getUiRelativeTimeFormatter', () => {
  it('rebuilds the formatter after a runtime language switch', () => {
    const english = getUiRelativeTimeFormatter()
    mockIntlLocale.value = 'ko'
    const korean = getUiRelativeTimeFormatter()
    expect(korean).not.toBe(english)
    expect(korean.format(-1, 'day')).toBe('어제')
  })
})
