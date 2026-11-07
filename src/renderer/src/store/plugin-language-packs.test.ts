// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n, setRendererPluginLanguagePacks } from '../i18n/i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { usePluginLanguagePackStore } from './plugin-language-packs'

afterEach(() => {
  vi.restoreAllMocks()
  setRendererPluginLanguagePacks([])
  usePluginLanguagePackStore.setState({ entries: [], loaded: false })
  vi.unstubAllGlobals()
})

describe('plugin language pack loading', () => {
  it('rejects a structured-cloned cyclic catalog before i18next resource installation', async () => {
    const id = 'plugin:cyclic' as const
    const catalog: Record<string, unknown> = { greeting: 'Hello' }
    catalog.self = catalog
    const response = structuredClone([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'cyclic',
        locale: 'en',
        catalog
      }
    ])
    vi.stubGlobal('window', {
      api: { plugins: { listLanguagePacks: vi.fn().mockResolvedValue(response) } }
    })

    await usePluginLanguagePackStore.getState().fetchEntries()
    const packs = usePluginLanguagePackStore.getState().entries

    expect(() => setRendererPluginLanguagePacks(packs)).not.toThrow()
    expect(packs).toEqual([])
  })

  it('rejects an inconsistent resource language before i18next owns its cleanup', async () => {
    vi.stubGlobal('window', {
      api: {
        plugins: {
          listLanguagePacks: vi.fn().mockResolvedValue([
            {
              id: 'plugin:bad',
              resourceLanguage: 'plugin.bad',
              pluginKey: 'bad',
              locale: 'en',
              catalog: {}
            }
          ])
        }
      }
    })

    await usePluginLanguagePackStore.getState().fetchEntries()
    setRendererPluginLanguagePacks(usePluginLanguagePackStore.getState().entries)
    const removeResourceBundle = vi
      .spyOn(i18n, 'removeResourceBundle')
      .mockImplementation((language) => {
        throw new Error(`invalid resource language: ${language}`)
      })

    expect(() => setRendererPluginLanguagePacks([])).not.toThrow()
    expect(removeResourceBundle).not.toHaveBeenCalled()
  })
})
