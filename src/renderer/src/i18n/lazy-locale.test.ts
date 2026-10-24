import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_PORTUGUESE,
  UI_LANGUAGE_SPANISH
} from '../../../shared/ui-language'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage, translate } from './i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/plugin-language-pack-artifact'

// Why: the renderer now lazy-loads non-English catalogs through an i18next
// backend instead of bundling all five into the startup chunk. This guards the
// invariant that switching language (I18nProvider effect / Settings) resolves
// real translations once changeLanguage() settles — and that any direct
// i18n.changeLanguage() call (used across the codebase and tests) transparently
// loads its catalog. A regression would silently show English to a user who
// picked another language.

describe('renderer i18n lazy locale loading', () => {
  beforeEach(async () => {
    setRendererPluginLanguagePacks([])
    await i18n.changeLanguage('en')
  })

  it('serves English synchronously from the eager bundle', () => {
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })

  it.each([
    ['es', 'Cargando proyectos y espacios de trabajo…'],
    ['fr', 'Chargement des projets et des espaces de travail…'],
    ['ja', 'プロジェクトとワークスペースを読み込み中…'],
    ['ko', '프로젝트 및 워크스페이스 로드 중…'],
    ['zh', '正在加载项目和工作区…']
  ])('loads the sidebar startup status in %s', async (locale, expected) => {
    await i18n.changeLanguage(locale)
    expect(translate('sidebar.loadingWorkspaces', 'Loading projects and workspaces…')).toBe(
      expected
    )
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
