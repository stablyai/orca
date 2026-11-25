import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { i18n, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import en from '@/i18n/locales/en.json'
import type { BrowserExtensionFailure } from '../../../../../../shared/browser/extensions/browser-extension-types'
import { browserExtensionFailureMessage } from './browser-extension-failure-message'

type Reason = BrowserExtensionFailure['reason']

const RAW_ERROR = 'RAW-ENGLISH-from-main'
const NAME = 'Foo: Bar, «Baz» & Co.'

// Exact t() arguments per reason; a reason added without a row fails typecheck here.
const CASES = {
  'support-disabled': {
    failure: { reason: 'support-disabled' },
    expectedCall: [
      'settings.browser.extensions.failure.supportDisabled',
      'Turn on browser extensions in Settings › Browser › Extensions'
    ]
  },
  'invalid-web-store-input': {
    failure: { reason: 'invalid-web-store-input' },
    expectedCall: [
      'settings.browser.extensions.failure.invalidWebStoreInput',
      'Paste a Chrome Web Store link or a 32-letter extension ID'
    ]
  },
  'profile-unavailable': {
    failure: { reason: 'profile-unavailable' },
    expectedCall: [
      'settings.browser.extensions.failure.profileUnavailable',
      'Browser profile is not available for extensions'
    ]
  },
  'already-added': {
    failure: { reason: 'already-added', name: NAME },
    expectedCall: [
      'settings.browser.extensions.failure.alreadyAdded',
      '{{name}} is already added',
      { name: NAME }
    ]
  }
} satisfies Record<
  Reason,
  { failure: BrowserExtensionFailure; expectedCall: [string, string] | [string, string, object] }
>

const ROWS = Object.entries(CASES) as [Reason, (typeof CASES)[Reason]][]

function englishCatalogValue(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  }, en)
}

describe('browserExtensionFailureMessage mapping', () => {
  it.each(ROWS)('%s calls t with its exact key, English fallback and options', (_, row) => {
    const t = vi.fn((key: string) => `T:${key}`) as unknown as Translate & ReturnType<typeof vi.fn>
    const message = browserExtensionFailureMessage(t, { error: RAW_ERROR, failure: row.failure })

    expect(t).toHaveBeenCalledTimes(1)
    expect(t.mock.calls[0]).toEqual(row.expectedCall)
    expect(message).toBe(`T:${row.expectedCall[0]}`)
    expect(englishCatalogValue(row.expectedCall[0])).toBe(row.expectedCall[1])
  })

  it('shows an untagged provider diagnostic unchanged, without translating it', () => {
    const t = vi.fn() as unknown as Translate & ReturnType<typeof vi.fn>
    expect(browserExtensionFailureMessage(t, { error: 'Download is too large' })).toBe(
      'Download is too large'
    )
    expect(t).not.toHaveBeenCalled()
  })
})

describe('browserExtensionFailureMessage with the real translator', () => {
  // A sentinel catalog for an unknown locale: no real catalog loads, so only these words exist.
  const SEEDED = {
    supportDisabled: 'xx: turn extensions on',
    invalidWebStoreInput: 'xx: paste a store link',
    profileUnavailable: 'xx: profile unavailable'
  }

  beforeAll(() => {
    i18n.addResourceBundle(
      'xx',
      'translation',
      {
        settings: {
          browser: {
            extensions: {
              failure: { ...SEEDED, alreadyAdded: '«{{name}}» ya está' }
            }
          }
        }
      },
      false,
      true
    )
    i18n.addResourceBundle(
      'xy',
      'translation',
      { settings: { browser: { extensions: { failure: { supportDisabled: 'xy: on' } } } } },
      false,
      true
    )
  })

  afterAll(() => {
    i18n.removeResourceBundle('xx', 'translation')
    i18n.removeResourceBundle('xy', 'translation')
  })

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the UI-language words for every reason, never main’s English', async () => {
    await i18n.changeLanguage('xx')
    const expected: Record<Reason, string> = {
      'support-disabled': SEEDED.supportDisabled,
      'invalid-web-store-input': SEEDED.invalidWebStoreInput,
      'profile-unavailable': SEEDED.profileUnavailable,
      'already-added': `«${NAME}» ya está`
    }
    for (const [reason, row] of ROWS) {
      expect(
        browserExtensionFailureMessage(translate, { error: RAW_ERROR, failure: row.failure })
      ).toBe(expected[reason])
    }
  })

  it('falls back to the en.json English when the UI language lacks the entry', async () => {
    // Neither the xy bundle nor the runtime English bundle holds these keys, so the only source
    // of the English is the helper's literal fallback, which must equal en.json.
    await i18n.changeLanguage('xy')
    for (const row of [CASES['profile-unavailable'], CASES['already-added']]) {
      expect(i18n.getResource('xy', 'translation', row.expectedCall[0])).toBeUndefined()
      expect(i18n.getResource('en', 'translation', row.expectedCall[0])).toBeUndefined()
    }
    const profile = CASES['profile-unavailable']
    expect(
      browserExtensionFailureMessage(translate, { error: RAW_ERROR, failure: profile.failure })
    ).toBe(englishCatalogValue(profile.expectedCall[0]))
    const added = CASES['already-added']
    expect(
      browserExtensionFailureMessage(translate, { error: RAW_ERROR, failure: added.failure })
    ).toBe(String(englishCatalogValue(added.expectedCall[0])).replace('{{name}}', NAME))
  })
})
