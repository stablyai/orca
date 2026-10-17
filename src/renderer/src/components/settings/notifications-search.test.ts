import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/i18n/localized-catalog', () => ({
  createLocalizedCatalog:
    <T>(loader: () => T) =>
    () =>
      loader()
}))

vi.mock('./settings-search-keywords', () => ({
  translateSearchKeyword: (_key: string, fallback: string) => [fallback]
}))

const mockPlatform = vi.mocked(await import('@/lib/renderer-app-platform'))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: vi.fn(() => 'darwin')
}))

import { getNotificationsPaneSearchEntries } from './notifications-search'

describe('getNotificationsPaneSearchEntries', () => {
  afterEach(() => {
    mockPlatform.getRendererAppPlatform.mockReturnValue('darwin')
  })

  it('indexes the Show Dock Badge toggle on darwin', () => {
    const entry = getNotificationsPaneSearchEntries().find(
      (candidate) => candidate.title === 'Show Dock Badge'
    )
    expect(entry?.keywords).toEqual(expect.arrayContaining(['dock', 'badge', 'notifications']))
  })

  it('keeps the base entries before the dock entry', () => {
    const titles = getNotificationsPaneSearchEntries().map((entry) => entry.title)
    expect(titles.indexOf('Enable Notifications')).toBeLessThan(titles.indexOf('Show Dock Badge'))
  })

  it('skips the dock entry where the Dock does not exist', () => {
    mockPlatform.getRendererAppPlatform.mockReturnValue('win32')
    const titles = getNotificationsPaneSearchEntries().map((entry) => entry.title)
    expect(titles).toContain('Enable Notifications')
    expect(titles).not.toContain('Show Dock Badge')
  })
})
