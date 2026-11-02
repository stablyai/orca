// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import {
  getCachedMarkdownRichModeEligibility,
  resetMarkdownRichModeEligibilityCache
} from './markdown-rich-mode-eligibility-cache'

describe('getCachedMarkdownRichModeEligibility', () => {
  beforeEach(() => {
    resetMarkdownRichModeEligibilityCache()
  })

  afterEach(() => {
    resetMarkdownRichModeEligibilityCache()
  })

  it('re-resolves the unsupported message per read instead of caching the string', async () => {
    const content = '# Title\n\n[ref]: https://example.com\n\nSee [ref].\n'
    const english = getCachedMarkdownRichModeEligibility({ content, sizeOverridden: false })
    expect(english.unsupportedMessage).toBe(
      'Editable only in code mode because this file contains reference-style links.'
    )

    await i18n.changeLanguage('ja')
    try {
      const japanese = getCachedMarkdownRichModeEligibility({ content, sizeOverridden: false })
      expect(japanese.unsupportedMessage).not.toBeNull()
      // Cache decisions only so every read resolves the active UI language.
      expect(japanese.unsupportedMessage).not.toBe(english.unsupportedMessage)
      expect(japanese.exceedsSizeLimit).toBe(english.exceedsSizeLimit)
    } finally {
      await i18n.changeLanguage('en')
    }

    expect(
      getCachedMarkdownRichModeEligibility({ content, sizeOverridden: false }).unsupportedMessage
    ).toBe(english.unsupportedMessage)
  })
})
