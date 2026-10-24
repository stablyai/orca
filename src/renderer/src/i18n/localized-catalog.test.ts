import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginLanguageResourceId } from '../../../shared/plugins/plugin-language-pack-artifact'
import {
  getExperimentalPaneSearchEntries,
  getExperimentalSearchEntry
} from '../components/settings/experimental-search'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage, translate } from './i18n'
import { createLocalizedCatalog } from './localized-catalog'

const PACK_ID = 'plugin:orca-test.traditional-chinese/zh-TW' as const
const PACK = {
  id: PACK_ID,
  resourceLanguage: pluginLanguageResourceId(PACK_ID),
  pluginKey: 'orca-test.traditional-chinese',
  locale: 'zh-TW',
  coverage: 100,
  catalog: {}
}

afterEach(async () => {
  await i18n.changeLanguage('en')
  setRendererPluginLanguagePacks([])
})

describe('localized catalog caching', () => {
  it('reuses a catalog while the language and resources are unchanged', () => {
    const builder = vi.fn(() => ({ title: translate('menu.file', 'File') }))
    const getCatalog = createLocalizedCatalog(builder)

    expect(getCatalog()).toBe(getCatalog())
    expect(builder).toHaveBeenCalledTimes(1)
  })

  it('rebuilds after switching languages', async () => {
    const getCatalog = createLocalizedCatalog(() => ({ title: translate('menu.file', 'File') }))
    const english = getCatalog()

    await i18n.changeLanguage('es')
    expect(getCatalog().title).toBe('Archivo')

    await i18n.changeLanguage('en')
    expect(getCatalog()).toEqual(english)
  })

  it('retries a failed rebuild instead of returning the previous language', async () => {
    const builder = vi.fn(() => ({ title: translate('menu.file', 'File') }))
    const getCatalog = createLocalizedCatalog(builder)
    expect(getCatalog().title).toBe('File')
    await i18n.changeLanguage('es')
    builder.mockImplementationOnce(() => {
      throw new Error('Catalog build failed')
    })

    expect(getCatalog).toThrow('Catalog build failed')
    expect(getCatalog().title).toBe('Archivo')
  })

  it('refreshes a cached fallback when resources are added to the active language', async () => {
    setRendererPluginLanguagePacks([PACK])
    await setRendererUiLanguage(PACK_ID)
    const getCatalog = createLocalizedCatalog(() => ({ title: translate('menu.file', 'File') }))
    expect(getCatalog().title).toBe('File')

    i18n.addResourceBundle(PACK.resourceLanguage, 'translation', { menu: { file: '檔案' } })

    expect(i18n.language).toBe(PACK.resourceLanguage)
    expect(getCatalog().title).toBe('檔案')
    expect(getCatalog()).toBe(getCatalog())
  })

  it('refreshes to the fallback when the active plugin resources are removed', async () => {
    setRendererPluginLanguagePacks([{ ...PACK, catalog: { menu: { file: '檔案' } } }])
    await setRendererUiLanguage(PACK_ID)
    const getCatalog = createLocalizedCatalog(() => ({ title: translate('menu.file', 'File') }))
    expect(getCatalog().title).toBe('檔案')

    setRendererPluginLanguagePacks([])

    expect(i18n.language).toBe(PACK.resourceLanguage)
    expect(getCatalog().title).toBe('File')
  })

  it('keeps Experimental lookups usable after an in-place plugin language pack update', async () => {
    const packWithTitles = (terminalAttention: string, newWorktreeCardStyle: string) => ({
      ...PACK,
      catalog: {
        auto: {
          components: {
            settings: {
              experimental: {
                search: {
                  '9e4ddf776d': terminalAttention,
                  newWorktreeCardStyle: { title: newWorktreeCardStyle }
                }
              }
            }
          }
        }
      }
    })
    setRendererPluginLanguagePacks([packWithTitles('終端關注', '舊卡片樣式')])
    await setRendererUiLanguage(PACK_ID)
    const original = getExperimentalPaneSearchEntries()
    expect(getExperimentalSearchEntry().terminalAttention.title).toBe('終端關注')
    expect(getExperimentalSearchEntry().newWorktreeCardStyle.title).toBe('舊卡片樣式')

    setRendererPluginLanguagePacks([packWithTitles('終端機關注', '新卡片樣式')])

    expect(i18n.language).toBe(PACK.resourceLanguage)
    expect(getExperimentalSearchEntry().terminalAttention.title).toBe('終端機關注')
    expect(getExperimentalSearchEntry().newWorktreeCardStyle.title).toBe('新卡片樣式')
    expect(getExperimentalPaneSearchEntries()).not.toBe(original)
    expect(getExperimentalPaneSearchEntries()).toBe(getExperimentalPaneSearchEntries())
  })
})
