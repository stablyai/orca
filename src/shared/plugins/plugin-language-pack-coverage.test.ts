import { describe, expect, it } from 'vitest'
import {
  isUsablePluginLanguagePack,
  pluginLanguagePackCoverage,
  translatableCatalogPaths
} from './plugin-language-pack-coverage'

const english = translatableCatalogPaths({
  common: { cancel: 'Cancel', save: 'Save', empty: '' },
  menu: { file: 'File', edit: 'Edit' },
  auto: { components: { settings: { PluginConsentDialog: { enable: 'Enable plugin' } } } }
})

describe('plugin language pack coverage', () => {
  it('counts only non-empty, translatable English strings', () => {
    expect([...english].sort()).toEqual(['common.cancel', 'common.save', 'menu.edit', 'menu.file'])
  })

  it('measures translated English paths and ignores keys English lacks', () => {
    expect(
      pluginLanguagePackCoverage(
        { common: { cancel: 'Cancelar', save: 'Salvar' }, menu: { quit: 'Sair' } },
        english
      )
    ).toBe(50)
    expect(
      pluginLanguagePackCoverage(
        { common: { cancel: 'A', save: 'B' }, menu: { file: 'C', edit: '' } },
        english
      )
    ).toBe(75)
    expect(pluginLanguagePackCoverage({ common: { cancel: 'x' } }, new Set())).toBe(0)
  })

  it('offers only packs at or above the floor', () => {
    expect(isUsablePluginLanguagePack({ coverage: 80 })).toBe(true)
    expect(isUsablePluginLanguagePack({ coverage: 79 })).toBe(false)
  })
})
