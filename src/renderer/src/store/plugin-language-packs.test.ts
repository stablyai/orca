// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n, setRendererPluginLanguagePacks } from '../i18n/i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/plugin-language-pack-artifact'
import { usePluginLanguagePackStore } from './plugin-language-packs'

afterEach(() => {
  vi.restoreAllMocks()
  setRendererPluginLanguagePacks([])
  usePluginLanguagePackStore.setState({ packs: [], loaded: false })
  vi.unstubAllGlobals()
})

describe('plugin language pack loading', () => {
  it('rejects malformed runtime IPC language-pack results at the renderer ingress', async () => {
    vi.stubGlobal('window', {
      api: {
        plugins: {
          listLanguagePacks: vi.fn().mockResolvedValue({ malformed: true })
        }
      }
    })

    await usePluginLanguagePackStore.getState().fetchPacks()

    const state = usePluginLanguagePackStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.packs).toEqual([])
    expect(() => state.packs.find(() => true)).not.toThrow()
  })

  it('filters malformed language-pack array members without changing valid order', async () => {
    const first = {
      id: 'plugin:first',
      resourceLanguage: pluginLanguageResourceId('plugin:first'),
      pluginKey: 'first',
      locale: 'pt-BR',
      catalog: { greeting: 'Olá' }
    }
    const second = {
      id: 'plugin:second',
      resourceLanguage: pluginLanguageResourceId('plugin:second'),
      pluginKey: 'second',
      locale: 'de',
      catalog: {}
    }
    vi.stubGlobal('window', {
      api: {
        plugins: {
          listLanguagePacks: vi
            .fn()
            .mockResolvedValue([null, first, { ...first, catalog: [] }, second])
        }
      }
    })

    await usePluginLanguagePackStore.getState().fetchPacks()

    expect(usePluginLanguagePackStore.getState().packs).toEqual([first, second])
  })

  it.each([
    ['Date', new Date(0)],
    ['Map', new Map([['greeting', 'Hello']])]
  ])('rejects a %s language-pack catalog at renderer ingress', async (_name, catalog) => {
    const id = 'plugin:malformed' as const
    vi.stubGlobal('window', {
      api: {
        plugins: {
          listLanguagePacks: vi.fn().mockResolvedValue([
            {
              id,
              resourceLanguage: pluginLanguageResourceId(id),
              pluginKey: 'malformed',
              locale: 'en',
              catalog
            }
          ])
        }
      }
    })

    await usePluginLanguagePackStore.getState().fetchPacks()

    expect(usePluginLanguagePackStore.getState().packs).toEqual([])
  })

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

    await usePluginLanguagePackStore.getState().fetchPacks()
    const packs = usePluginLanguagePackStore.getState().packs

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

    await usePluginLanguagePackStore.getState().fetchPacks()
    setRendererPluginLanguagePacks(usePluginLanguagePackStore.getState().packs)
    const removeResourceBundle = vi
      .spyOn(i18n, 'removeResourceBundle')
      .mockImplementation((language) => {
        throw new Error(`invalid resource language: ${language}`)
      })

    expect(() => setRendererPluginLanguagePacks([])).not.toThrow()
    expect(removeResourceBundle).not.toHaveBeenCalled()
  })

  it('rejects a missing resource language before i18next resource installation', async () => {
    vi.stubGlobal('window', {
      api: {
        plugins: {
          listLanguagePacks: vi.fn().mockResolvedValue([
            {
              id: 'plugin:missing-language',
              resourceLanguage: undefined,
              pluginKey: 'missing-language',
              locale: 'en',
              catalog: {}
            }
          ])
        }
      }
    })

    await usePluginLanguagePackStore.getState().fetchPacks()
    const packs = usePluginLanguagePackStore.getState().packs

    expect(() => setRendererPluginLanguagePacks(packs)).not.toThrow()
    expect(packs).toEqual([])
  })

  it('keeps the latest request when an older language-pack response finishes last', async () => {
    const older = {
      id: 'plugin:older',
      resourceLanguage: pluginLanguageResourceId('plugin:older'),
      pluginKey: 'older',
      locale: 'de',
      catalog: {}
    }
    const latest = {
      id: 'plugin:latest',
      resourceLanguage: pluginLanguageResourceId('plugin:latest'),
      pluginKey: 'latest',
      locale: 'fr',
      catalog: {}
    }
    let resolveOlder!: (value: unknown[]) => void
    const olderResponse = new Promise<unknown[]>((resolve) => {
      resolveOlder = resolve
    })
    vi.stubGlobal('window', {
      api: {
        plugins: {
          listLanguagePacks: vi
            .fn()
            .mockReturnValueOnce(olderResponse)
            .mockResolvedValueOnce([latest])
        }
      }
    })

    const olderFetch = usePluginLanguagePackStore.getState().fetchPacks()
    await usePluginLanguagePackStore.getState().fetchPacks()
    resolveOlder([older])
    await olderFetch

    expect(usePluginLanguagePackStore.getState().packs).toEqual([latest])
  })
})
