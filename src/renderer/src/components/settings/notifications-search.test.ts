import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scoreSettingsSearch } from './settings-search'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bring-to-front settings search', () => {
  it.each([
    ['Macintosh', true],
    ['Windows NT 10.0', false],
    ['X11; Linux x86_64', false]
  ] as const)('matches the visible controls on %s', async (userAgent, visible) => {
    vi.stubGlobal('navigator', { userAgent })
    const { i18n } = await import('@/i18n/i18n')
    await i18n.changeLanguage('en')
    const { getNotificationsPaneSearchEntries } = await import('./notifications-search')
    for (const query of ['Bring Orca to Front', 'foreground', 'reply']) {
      expect(scoreSettingsSearch(query, getNotificationsPaneSearchEntries()) > 0).toBe(visible)
    }
  })

  it.each([
    ['ko', '전경'],
    ['ja', '前面'],
    ['zh', '前台'],
    ['es', 'primer plano'],
    ['fr', 'premier plan'],
    ['pt', 'primeiro plano']
  ])('finds the control with localized keywords in %s', async (locale, query) => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const { i18n } = await import('@/i18n/i18n')
    await i18n.changeLanguage(locale)
    const { getNotificationsPaneSearchEntries } = await import('./notifications-search')
    expect(scoreSettingsSearch(query, getNotificationsPaneSearchEntries())).toBeGreaterThan(0)
  })
})
