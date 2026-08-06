import { afterAll, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { getDeveloperPermissionsPaneSearchEntries } from './developer-permissions-search'
import { matchesSettingsSearch } from './settings-search'

// Strings macOS 26 System Settings itself shows for the Local Network privacy
// toggle (SecurityPrivacyExtension.appex Localizable.loctable, key LOCAL_NETWORK).
const MACOS_LOCAL_NETWORK_LABEL = {
  en: 'local network',
  es: 'red local',
  ja: 'ローカルネットワーク',
  ko: '로컬 네트워크',
  zh: '本地网络'
} as const

function getLanEntry() {
  const entry = getDeveloperPermissionsPaneSearchEntries().find((candidate) =>
    candidate.keywords?.includes('usb')
  )
  if (!entry) {
    throw new Error('LAN, USB, and Bluetooth search entry is missing')
  }
  return entry
}

async function searchInLocale(locale: string, query: string): Promise<boolean> {
  await i18n.changeLanguage(locale)
  return matchesSettingsSearch(query, getLanEntry())
}

describe('developer permissions LAN search', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it.each(Object.entries(MACOS_LOCAL_NETWORK_LABEL))(
    'finds the LAN row from the macOS Local Network wording in %s',
    async (locale, label) => {
      expect(await searchInLocale(locale, label)).toBe(true)
    }
  )

  it('keeps the English LAN aliases findable in every locale', async () => {
    for (const locale of Object.keys(MACOS_LOCAL_NETWORK_LABEL)) {
      for (const query of ['lan', 'local network', 'local-network']) {
        expect(await searchInLocale(locale, query)).toBe(true)
      }
    }
  })

  it('keeps the localized LAN wording findable', async () => {
    expect(await searchInLocale('zh', '局域网')).toBe(true)
    expect(await searchInLocale('ja', 'LAN')).toBe(true)
    expect(await searchInLocale('ko', 'LAN')).toBe(true)
    expect(await searchInLocale('es', 'LAN')).toBe(true)
  })

  it('indexes both wordings as distinct Chinese keywords', async () => {
    await i18n.changeLanguage('zh')
    expect(getLanEntry().keywords).toEqual(expect.arrayContaining(['局域网', '本地网络']))
  })
})
