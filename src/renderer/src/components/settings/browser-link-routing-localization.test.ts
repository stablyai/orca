import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { getBrowserLinkRoutingDescription } from './browser-link-routing-copy'

// The Link Routing description was a bare template literal, so it stayed English in every
// locale while its own title and the rest of the pane translated. It carries the platform
// shortcut label, so each locale must interpolate it rather than embed a hardcoded modifier.
const NON_ENGLISH_LOCALES = ['es', 'ja', 'ko', 'zh'] as const

const SHORTCUT_BY_PLATFORM = {
  mac: '⇧⌘-click',
  other: 'Shift+Ctrl+click'
} as const

describe('Link Routing description localization', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates the description in every non-English locale on both platforms', async () => {
    const english = {
      mac: getBrowserLinkRoutingDescription({ isMac: true }),
      other: getBrowserLinkRoutingDescription({ isMac: false })
    }

    for (const locale of NON_ENGLISH_LOCALES) {
      await i18n.changeLanguage(locale)

      for (const [platform, shortcut] of Object.entries(SHORTCUT_BY_PLATFORM)) {
        const description = getBrowserLinkRoutingDescription({ isMac: platform === 'mac' })

        expect(description, `${locale}/${platform} fell back to English`).not.toBe(
          english[platform as keyof typeof english]
        )
        // The label is a key symbol, not prose: it stays literal in every locale.
        expect(description, `${locale}/${platform} lost the shortcut label`).toContain(shortcut)
        expect(description, `${locale}/${platform} leaked a placeholder`).not.toMatch(/\{\{.+?\}\}/)
      }
    }
  })

  it('keeps each platform label out of the other platform copy', async () => {
    for (const locale of ['en', ...NON_ENGLISH_LOCALES]) {
      await i18n.changeLanguage(locale)

      expect(getBrowserLinkRoutingDescription({ isMac: true })).not.toContain(
        SHORTCUT_BY_PLATFORM.other
      )
      expect(getBrowserLinkRoutingDescription({ isMac: false })).not.toContain(
        SHORTCUT_BY_PLATFORM.mac
      )
    }
  })
})
