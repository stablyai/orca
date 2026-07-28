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
