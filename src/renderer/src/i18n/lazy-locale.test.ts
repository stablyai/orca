import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_PORTUGUESE,
  UI_LANGUAGE_RUSSIAN,
  UI_LANGUAGE_SPANISH
} from '../../../shared/ui-language'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage } from './i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/plugin-language-pack-artifact'

// Every changeLanguage caller must transparently load real non-English translations before its promise settles.

describe('renderer i18n lazy locale loading', () => {
  beforeEach(async () => {
    setRendererPluginLanguagePacks([])
    await i18n.changeLanguage('en')
  })

  it('serves English synchronously from the eager bundle', () => {
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })

  it('lazy-loads Spanish via setRendererUiLanguage before it resolves', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.language).toBe('es')
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')
  })

  it('lazy-loads a catalog through a direct changeLanguage call', async () => {
    await i18n.changeLanguage(UI_LANGUAGE_CHINESE)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).not.toBe('File')
  })

  it('lazy-loads Portuguese via setRendererUiLanguage before it resolves', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_PORTUGUESE)
    expect(i18n.language).toBe('pt')
    expect(i18n.t('menu.file', { defaultValue: 'File' })).not.toBe('File')
  })

  it('loads Russian and selects its complete CLDR plural family', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_RUSSIAN)
    expect(i18n.language).toBe('ru')
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Файл')
    for (const [count, expected] of [
      [0, '0 изображений'],
      [1, '1 изображение'],
      [2, '2 изображения'],
      [5, '5 изображений'],
      [11, '11 изображений'],
      [21, '21 изображение'],
      [22, '22 изображения'],
      [25, '25 изображений'],
      [1.5, '1.5 изображения']
    ] as const) {
      expect(
        i18n.t('components.native-chat.queuedMessages.imageCount', {
          defaultValue: '{{count}} images',
          count
        })
      ).toBe(expected)
    }
  })

  it('falls back from Traditional Chinese to English, never Simplified', async () => {
    i18n.addResourceBundle('zh', 'translation', { zhOnlyKey: '简体' }, true, true)
    await setRendererUiLanguage(UI_LANGUAGE_CHINESE_TRADITIONAL)
    expect(i18n.language).toBe('zh-Hant')
    expect(i18n.t('menu.file', { defaultValue: 'File' })).not.toBe('File')
    expect(i18n.t('zhOnlyKey', { defaultValue: 'English' })).toBe('English')
  })

  it.each(['network', 'http', 'invalid-json'] as const)(
    'retries a rejected %s catalog load with a fresh request',
    async (failure) => {
      i18n.removeResourceBundle('ja', 'translation')
      const request = vi.spyOn(globalThis, 'fetch')
      if (failure === 'network') {
        request.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      } else {
        request.mockResolvedValueOnce(
          failure === 'http' ? new Response('', { status: 503 }) : new Response('{')
        )
      }
      try {
        await expect(setRendererUiLanguage('ja')).rejects.toThrow('Language catalog unavailable')
        expect(i18n.language).toBe('en')
        expect(i18n.hasResourceBundle('ja', 'translation')).toBe(false)

        await setRendererUiLanguage('ja')
        expect(i18n.language).toBe('ja')
        expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('ファイル')
        expect(request).toHaveBeenCalledTimes(2)
      } finally {
        request.mockRestore()
      }
    }
  )

  it('uses the inline English default when a target catalog omits a key', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.t('missing.renderer.feature', { defaultValue: 'English fallback' })).toBe(
      'English fallback'
    )
  })

  it('returns to English from a lazily-loaded locale', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')

    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })

  it('loads an isolated catalog contributed by an enabled plugin', async () => {
    const id = 'plugin:orca-samples.portuguese/pt-BR' as const
    setRendererPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'orca-samples.portuguese',
        locale: 'pt-BR',
        catalog: { menu: { file: 'Arquivo Orca' } }
      }
    ])

    await setRendererUiLanguage(id)
    expect(i18n.language).toBe(pluginLanguageResourceId(id))
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Arquivo Orca')

    setRendererPluginLanguagePacks([])
    await setRendererUiLanguage(id)
    expect(i18n.language).toBe('en')
  })
})
