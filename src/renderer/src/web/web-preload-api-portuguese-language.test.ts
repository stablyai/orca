import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installBrowserGlobals } from './web-preload-api-test-harness'

describe('web Portuguese language migration', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['plugin:stablyai.orca-portuguese/pt-BR', 'en'] as const)(
    'persists the Portuguese receipt and later plugin reselection for %s',
    async (language) => {
      const plugin = 'plugin:stablyai.orca-portuguese/pt-BR'
      const globals = installBrowserGlobals('Linux')
      globals.storage.setItem(
        'orca.web.settings.v1',
        JSON.stringify({
          uiLanguage: language,
          terminalFontSize: 19,
          futureSetting: { retained: true }
        })
      )
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const expected = language === plugin ? 'pt' : language
      expect(globals.window.api.settings.getSync()).toMatchObject({
        uiLanguage: expected,
        uiLanguagePortugueseMigrationApplied: true
      })
      expect(await globals.window.api.settings.get()).toMatchObject({ uiLanguage: expected })
      expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
        uiLanguage: expected,
        uiLanguagePortugueseMigrationApplied: true,
        terminalFontSize: 19,
        futureSetting: { retained: true }
      })
      await globals.window.api.settings.set({ uiLanguage: plugin })
      await globals.window.api.settings.set({ terminalFontSize: 20 })
      vi.resetModules()
      const reloaded = await import('./web-preload-api')
      reloaded.installWebPreloadApi()
      expect(await globals.window.api.settings.get()).toMatchObject({
        uiLanguage: plugin,
        uiLanguagePortugueseMigrationApplied: true,
        terminalFontSize: 20
      })
    }
  )
})
