import { describe, expect, it } from 'vitest'
import {
  parsePluginLanguagePackArtifact,
  PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH,
  PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES,
  validatePluginLanguagePackCatalog,
  pluginLanguageResourceId
} from './plugin-language-pack-artifact'

describe('plugin language-pack artifacts', () => {
  it('maps qualified IDs to distinct canonical private-use tags on the pack locale', () => {
    const first = pluginLanguageResourceId('plugin:a.bc/ru-RU')
    const second = pluginLanguageResourceId('plugin:ab.c/ru-RU')

    for (const resourceLanguage of [first, second]) {
      expect(resourceLanguage).toMatch(/^ru-RU-x-orcapk-/)
      expect(Intl.getCanonicalLocales(resourceLanguage)).toEqual([resourceLanguage])
    }
    expect(first).not.toBe(second)
  })

  it('accepts nested string catalogs and reports their bounded entry count', () => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          settings: { appearance: { title: 'Aparência' } },
          common: { save: 'Salvar' }
        })
      )
    ).toEqual({
      ok: true,
      catalog: {
        settings: { appearance: { title: 'Aparência' } },
        common: { save: 'Salvar' }
      },
      entries: 5
    })
  })

  it('drops protected copy instead of rejecting the pack when loading tolerantly', () => {
    const raw = JSON.stringify({
      common: { save: 'Sávé' },
      components: { 'native-chat': { approval: { allow: 'Álló' }, title: 'Çhát' } }
    })

    expect(parsePluginLanguagePackArtifact(raw).ok).toBe(false)
    expect(parsePluginLanguagePackArtifact(raw, 'tolerant')).toMatchObject({
      ok: true,
      catalog: { common: { save: 'Sávé' }, components: { 'native-chat': { title: 'Çhát' } } }
    })
  })

  it.each([
    'PluginConsentDialog',
    // The provenance badge and install-error copy carry the trust decision.
    'PluginConsentProvenance',
    'pluginError',
    'PluginKeybindingConsentPreview',
    'PluginMarketplaceListingRow',
    'PluginUpdateAllDialog',
    'PluginMarketplaceSourceDialog',
    'PluginVmRecipeConsentPreview',
    // The inline consent and its copy replaced the review dialog.
    'PluginInstallConsent',
    'PluginPageAction',
    'pluginConsentCopy',
    'pluginInstallAction'
  ])('prevents language packs from rewriting %s security copy', (component) => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: {
            components: {
              settings: { [component]: { disclaimer: 'This plugin is perfectly safe.' } }
            }
          }
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('protected security copy') })
  })

  it.each([
    ['PluginsSettingsSection', 'title', 'Плагины'],
    ['PluginMarketplaceBrowser', 'refresh', 'Обновить'],
    ['PluginDevelopmentSection', 'title', 'Разработка']
  ])('lets a language pack translate %s.%s, which asserts nothing', (component, key, value) => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: { components: { settings: { [component]: { [key]: value } } } }
        })
      ).ok
    ).toBe(true)
  })

  // Chrome exemptions must never include claims about plugin permissions; those are the protected prefix’s purpose.
  it.each([
    ['description', 'Plugins are sandboxed and cannot read your files.'],
    ['systemDescription', 'Every plugin here has been reviewed by Orca.']
  ])('still refuses PluginsSettingsSection.%s', (key, value) => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: { components: { settings: { PluginsSettingsSection: { [key]: value } } } }
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('protected security copy') })
  })

  it('still refuses the development-plugin permission promise', () => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: {
            components: {
              settings: {
                PluginDevelopmentSection: { help: 'Dev plugins skip permission review.' }
              }
            }
          }
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('protected security copy') })
  })

  it('still refuses install failure copy that reports a trust event', () => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: {
            components: {
              settings: { PluginMarketplaceBrowser: { installFailed: 'Installed successfully.' } }
            }
          }
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('protected security copy') })
  })

  it.each([
    [
      'the Official badge',
      { auto: { components: { pluginCatalog: { PluginListRow: { official: 'x' } } } } }
    ],
    [
      'the suggestion banner',
      { auto: { components: { editor: { PluginFileTypeSuggestion: { view: 'x' } } } } }
    ],
    [
      'agent Allow/Deny',
      { components: { 'native-chat': { approval: { allow: 'Deny', deny: 'Allow' } } } }
    ],
    [
      'the orca.yaml trust dialog',
      { auto: { components: { sidebar: { OrcaYamlTrustDialog: { '43b7bec4cd': 'Run' } } } } }
    ],
    [
      'the notebook trust dialog',
      { auto: { components: { editor: { IpynbViewer: { '9e06ae5d36': 'Open notebook?' } } } } }
    ],
    ['the certificate warning', { browser: { loadFailure: { proceedUnsafe: 'Continue' } } }],
    [
      'the site permission prompt',
      { auto: { components: { browserPane: { sitePermission: { allow: 'Block' } } } } }
    ],
    ['site permission settings', { settings: { browser: { sitePermissions: { block: 'Allow' } } } }]
  ])('refuses to relabel %s', (_label, catalog) => {
    expect(parsePluginLanguagePackArtifact(JSON.stringify(catalog))).toMatchObject({
      ok: false,
      error: expect.stringContaining('protected security copy')
    })
  })

  it('still translates neighbours of protected components', () => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: { components: { pluginCatalog: { PluginListRow: { install: 'Instalar' } } } },
          components: { 'native-chat': { composer: { send: 'Enviar' } } }
        })
      ).ok
    ).toBe(true)
  })

  it('still lets language packs translate non-plugin settings copy', () => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: { components: { settings: { AppearanceSection: { title: 'Apariencia' } } } }
        })
      ).ok
    ).toBe(true)
  })

  it.each([
    ['array leaf', { settings: { choices: ['one'] } }],
    ['numeric leaf', { settings: { count: 1 } }],
    ['dotted key', { 'settings.title': 'Title' }],
    ['prototype key', JSON.parse('{"__proto__":"bad"}')]
  ])('rejects %s', (_label, catalog) => {
    expect(parsePluginLanguagePackArtifact(JSON.stringify(catalog)).ok).toBe(false)
  })

  it('rejects excessive nesting without recursive validation', () => {
    let catalog: Record<string, unknown> = { value: 'deep' }
    for (let index = 0; index <= PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH; index += 1) {
      catalog = { nested: catalog }
    }
    expect(parsePluginLanguagePackArtifact(JSON.stringify(catalog))).toMatchObject({
      ok: false,
      error: expect.stringContaining('depth')
    })
  })

  it('accepts the entry limit and rejects one additional entry', () => {
    const catalog = Object.fromEntries(
      Array.from({ length: PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES }, (_, index) => [
        `key${index}`,
        'value'
      ])
    )

    expect(validatePluginLanguagePackCatalog(catalog)).toMatchObject({
      ok: true,
      entries: PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES
    })
    catalog.overflow = 'value'
    expect(validatePluginLanguagePackCatalog(catalog)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES} entries`)
    })
  })
})
