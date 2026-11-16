import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/ui-intl-formatters', () => ({
  languageDisplayName: (locale: string, display: string) => `${locale}@${display}`
}))

import { deviceLanguageOffer } from './device-language-offer'
import type { CatalogLanguagePack } from './language-pack-options'
import type { PluginLanguagePackRegistration } from '../../../../shared/plugins/artifacts/plugin-language-pack-artifact'

const installedPack = (locale: string): PluginLanguagePackRegistration => ({
  id: `plugin:ebbop.orca-${locale}/${locale}`,
  resourceLanguage: locale,
  pluginKey: `ebbop.orca-${locale}`,
  locale,
  catalog: {},
  coverage: 94
})

const catalogPack = (locale: string): CatalogLanguagePack =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offer reads only id, locale and listing.pluginKey.
  ({
    id: `plugin:other.orca-${locale}/${locale}`,
    locale,
    listing: { pluginKey: `other.orca-${locale}` }
  }) as CatalogLanguagePack

describe('deviceLanguageOffer', () => {
  it('offers to install a catalog pack that matches the device', () => {
    const offer = deviceLanguageOffer([], [catalogPack('it')], 'it-IT')
    expect(offer).toMatchObject({
      locale: 'it',
      installed: null,
      name: 'it@it',
      englishName: 'it@en'
    })
    expect(offer?.catalog?.id).toBe('plugin:other.orca-it/it')
  })

  it('offers to switch to an installed match instead of installing another copy', () => {
    const offer = deviceLanguageOffer([installedPack('it')], [catalogPack('it')], 'it-IT')
    expect(offer?.installed?.id).toBe('plugin:ebbop.orca-it/it')
    expect(offer?.catalog).toBeNull()
  })

  it('returns null when nothing matches the device', () => {
    expect(deviceLanguageOffer([installedPack('vi')], [catalogPack('uk')], 'it-IT')).toBeNull()
    expect(deviceLanguageOffer([installedPack('it')], [], null)).toBeNull()
  })
})
