// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getMarkdownRichModeEligibility } from './markdown-rich-mode'
import {
  getCachedMarkdownRichModeEligibility,
  resetMarkdownRichModeEligibilityCache
} from './markdown-rich-mode-eligibility-cache'

const OVERSIZED_BODY = `${'lorem ipsum dolor sit amet '.repeat(2_500)}\n<span>tail</span>\n`

const CORPUS: { name: string; content: string }[] = [
  { name: 'empty', content: '' },
  { name: 'whitespace only', content: '   \n\n\t\n' },
  { name: 'plain markdown', content: '# Title\n\nA paragraph with **bold** text.\n' },
  {
    name: 'front matter only',
    content: '---\ntitle: Notes\ntags: [a, b]\n---\n\n# Body\n\nText.\n'
  },
  {
    name: 'front matter with embedded html',
    content: '---\ntitle: Notes\n---\n\n<div class="callout">Hi</div>\n\nText.\n'
  },
  { name: 'embedded html', content: '# Title\n\n<div class="callout">Hi</div>\n\nText.\n' },
  { name: 'html comment', content: '# Title\n\n<!-- hidden note -->\n\nText.\n' },
  {
    name: 'html inside a fenced code block',
    content: '# Title\n\n```html\n<div>not real markup</div>\n```\n\nText.\n'
  },
  { name: 'html inside inline code', content: '# Title\n\nUse `<div>` here.\n' },
  { name: 'reference links', content: '# Title\n\n[ref]: https://example.com\n\nSee [ref].\n' },
  { name: 'footnotes', content: '# Title\n\nText[^1]\n\n[^1]: A footnote.\n' },
  { name: 'jsx-ish tag', content: '# Title\n\n<MyComponent prop="1" />\n' },
  { name: 'CRLF plain', content: '# Title\r\n\r\nA paragraph.\r\n' },
  { name: 'CRLF with html', content: '# Title\r\n\r\n<div>Hi</div>\r\n\r\nText.\r\n' },
  {
    name: 'CRLF with front matter',
    content: '---\r\ntitle: Notes\r\n---\r\n\r\n<!-- note -->\r\n\r\nText.\r\n'
  },
  { name: 'over the 50 KB round-trip threshold, with html', content: OVERSIZED_BODY },
  {
    name: 'over the 50 KB round-trip threshold, with front matter and html',
    content: `---\ntitle: Big\n---\n\n${OVERSIZED_BODY}`
  }
]

describe('getCachedMarkdownRichModeEligibility', () => {
  beforeEach(() => {
    resetMarkdownRichModeEligibilityCache()
  })

  afterEach(() => {
    resetMarkdownRichModeEligibilityCache()
  })

  it.each(CORPUS)('matches the unmemoized classifier for $name', ({ content }) => {
    for (const sizeOverridden of [false, true]) {
      const expected = getMarkdownRichModeEligibility({ content, sizeOverridden })
      resetMarkdownRichModeEligibilityCache()
      // Cold, then warm — both must equal the uncached classifier.
      expect(getCachedMarkdownRichModeEligibility({ content, sizeOverridden })).toEqual(expected)
      expect(getCachedMarkdownRichModeEligibility({ content, sizeOverridden })).toEqual(expected)
    }
  })

  it('keys on the sizeOverridden flag as well as the content', () => {
    const content = OVERSIZED_BODY
    expect(getCachedMarkdownRichModeEligibility({ content, sizeOverridden: false })).toEqual(
      getMarkdownRichModeEligibility({ content, sizeOverridden: false })
    )
    expect(getCachedMarkdownRichModeEligibility({ content, sizeOverridden: true })).toEqual(
      getMarkdownRichModeEligibility({ content, sizeOverridden: true })
    )
  })

  it('stays correct once the corpus exceeds the cache capacity', () => {
    const expected = CORPUS.map(({ content }) =>
      getMarkdownRichModeEligibility({ content, sizeOverridden: false })
    )
    resetMarkdownRichModeEligibilityCache()
    for (let pass = 0; pass < 3; pass += 1) {
      CORPUS.forEach(({ content }, index) => {
        expect(getCachedMarkdownRichModeEligibility({ content, sizeOverridden: false })).toEqual(
          expected[index]
        )
      })
    }
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
      // Why: the decision is cached but the localized string is not, so a cache
      // hit still follows the language active at read time.
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
