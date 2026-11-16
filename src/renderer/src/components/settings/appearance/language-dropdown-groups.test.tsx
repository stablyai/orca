import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/ui-intl-formatters', () => ({
  languageDisplayName: (locale: string, display: string) =>
    display === 'en' ? `${locale}-english` : `${locale}-native`
}))

import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import type { CatalogLanguagePack } from '@/components/languages/language-pack-options'
import { INSTALL_LANGUAGE_VALUE_PREFIX, languageDropdownGroups } from './language-dropdown-groups'

const t = (_key: string, fallback: string, values?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

const builtIns = [{ value: 'en', label: 'English' }]

function catalogPack(publisher: string, locale: string): CatalogLanguagePack {
  const pluginKey = `${publisher}.orca-${locale}`
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only listing.pluginKey.
  const listing = { pluginKey } as CatalogLanguagePack['listing']
  return { id: `plugin:${pluginKey}/${locale}`, locale, listing }
}

function installedPack(publisher: string, locale: string): PluginLanguagePackRegistration {
  const pluginKey = `${publisher}.orca-${locale}`
  return {
    id: `plugin:${pluginKey}/${locale}`,
    resourceLanguage: locale,
    pluginKey,
    locale,
    catalog: {},
    coverage: 90
  }
}

describe('languageDropdownGroups', () => {
  it('lists installed packs and installable catalog packs under Community translations', () => {
    const groups = languageDropdownGroups({
      builtIns,
      installed: [installedPack('ebbop', 'it')],
      catalog: [catalogPack('ebbop', 'it'), catalogPack('other', 'it'), catalogPack('d', 'vi')],
      t
    })
    expect(groups.map((group) => group.key)).toEqual(['built-in', 'community'])
    const community = groups[1]
    expect(community.separated).toBe(true)
    // The installed copy is listed once, as itself; only the others install.
    expect(community.options.map((option) => option.value)).toEqual([
      'plugin:ebbop.orca-it/it',
      `${INSTALL_LANGUAGE_VALUE_PREFIX}plugin:other.orca-it/it`,
      `${INSTALL_LANGUAGE_VALUE_PREFIX}plugin:d.orca-vi/vi`
    ])
    expect(community.options[0]).toMatchObject({ label: 'it-native', lang: 'it' })
    expect(community.options[0].keywords).toEqual(['it-english', 'it', 'ebbop'])
  })

  it('lists only installed packs until the catalog is ready, and no group when there are none', () => {
    expect(
      languageDropdownGroups({ builtIns, installed: [], catalog: [], t }).map((group) => group.key)
    ).toEqual(['built-in'])
    const groups = languageDropdownGroups({
      builtIns,
      installed: [installedPack('ebbop', 'it')],
      catalog: [],
      t
    })
    expect(groups[1].options.map((option) => option.value)).toEqual(['plugin:ebbop.orca-it/it'])
  })
})
