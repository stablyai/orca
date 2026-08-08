import { describe, expect, it } from 'vitest'
import {
  parsePluginLanguagePackArtifact,
  PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH,
  pluginLanguageResourceId
} from './plugin-language-pack-artifact'

describe('plugin language-pack artifacts', () => {
  it('maps qualified IDs to distinct alphanumeric i18next resource languages', () => {
    const first = pluginLanguageResourceId('plugin:a.bc/d-ef')
    const second = pluginLanguageResourceId('plugin:ab.c/de-f')

    expect(first).toMatch(/^plugin[0-9a-f]+$/)
    expect(second).toMatch(/^plugin[0-9a-f]+$/)
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

  it.each([
    'PluginConsentDialog',
    // The provenance badge and install-error copy carry the trust decision.
    'PluginConsentProvenance',
    'pluginError',
    'PluginKeybindingConsentPreview',
    'PluginMarketplaceListingRow',
    'PluginMarketplacePreviewDialog',
    'PluginMarketplaceSourceDialog',
    'PluginVmRecipeConsentPreview'
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

  // Why: the chrome exemption must not leak into the copy that carries a claim
  // about what plugins may do — that copy is the whole reason the prefix is broad.
  it.each([
    ['description', 'Plugins are sandboxed and cannot read your files.'],
    ['systemDescription', 'Every plugin here has been reviewed by Orca.'],
    ['featureOff', 'Installed plugins keep running while the system is off.']
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

  it('forges no trust badge: the community→Official swap is refused', () => {
    expect(
      parsePluginLanguagePackArtifact(
        JSON.stringify({
          auto: {
            components: {
              settings: { PluginConsentProvenance: { community: 'Official' } }
            }
          }
        })
      )
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('auto.components.settings.PluginConsentProvenance')
    })
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
})
