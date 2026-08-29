/**
 * `getIntlLocale()` exists because plugin catalogs register under a synthetic
 * `plugin<hex>` resource language. Passing that straight to `Intl` throws, and
 * passing `undefined` silently falls back to the OS locale rather than the
 * language the user selected.
 *
 * The branch assertions stub `supportedLocalesOf` so they describe the helper's
 * logic rather than whichever locales the runtime's ICU build happens to carry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getIntlLocale, i18n, setRendererPluginLanguagePacks } from './i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/plugin-language-pack-artifact'
import { DEFAULT_LOCALE } from './supported-languages'

const PACK_ID = 'plugin:smwbev.russian/ru-RU' as const
const PACK_RESOURCE = pluginLanguageResourceId(PACK_ID)
const PACK = {
  id: PACK_ID,
  resourceLanguage: PACK_RESOURCE,
  pluginKey: 'smwbev.russian',
  locale: 'ru-RU',
  catalog: {}
}

type Packs = Parameters<typeof setRendererPluginLanguagePacks>[0]

async function activate(language: string, packs: Packs = []): Promise<void> {
  setRendererPluginLanguagePacks(packs)
  await i18n.changeLanguage(language)
}

/** Stubs ICU lookup so a locale counts as supported only when listed. */
function withSupportedLocales(supported: readonly string[]): void {
  vi.spyOn(Intl.DateTimeFormat, 'supportedLocalesOf').mockImplementation((requested) => {
    const tags = Array.isArray(requested) ? requested : [requested as string]
    return tags.filter((tag) => supported.includes(tag)) as string[]
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  setRendererPluginLanguagePacks([])
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

describe('getIntlLocale', () => {
  it('passes a supported built-in locale straight through', async () => {
    withSupportedLocales(['es'])
    await activate('es')
    expect(getIntlLocale()).toBe('es')
  })

  it('resolves a plugin resource language to the locale the pack declares', async () => {
    withSupportedLocales(['ru-RU'])
    await activate(PACK_RESOURCE, [PACK])
    // Without the pack lookup this would reach Intl as `plugin<hex>`.
    expect(getIntlLocale()).toBe('ru-RU')
  })

  it('falls back to the default locale when ICU has no data for the tag', async () => {
    withSupportedLocales([])
    await activate('es')
    // Returning the tag here would let Intl silently format with the runtime locale.
    expect(getIntlLocale()).toBe(DEFAULT_LOCALE)
  })

  it('falls back to the default locale when Intl rejects the tag', async () => {
    vi.spyOn(Intl.DateTimeFormat, 'supportedLocalesOf').mockImplementation(() => {
      throw new RangeError('invalid language tag')
    })
    await activate(PACK_RESOURCE)
    expect(getIntlLocale()).toBe(DEFAULT_LOCALE)
  })

  it('keeps the synthetic resource language unusable for Intl directly', () => {
    // Unstubbed on purpose: this is a property of the tag, not of ICU data.
    expect(() => Intl.DateTimeFormat.supportedLocalesOf(PACK_RESOURCE)).toThrow(RangeError)
  })
})
