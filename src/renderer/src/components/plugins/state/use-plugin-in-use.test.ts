import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { pluginInUse } from './use-plugin-in-use'

const theme = (pluginKey: string, base: 'light' | 'dark'): PluginThemeRegistration => ({
  id: `plugin:${pluginKey}/${base}`,
  pluginKey,
  pluginName: pluginKey,
  label: base,
  revision: 'r1',
  base,
  tokens: {}
})
const pack: PluginLanguagePackRegistration = {
  id: 'plugin:acme.xa/en-XA',
  resourceLanguage: 'plugin00',
  pluginKey: 'acme.xa',
  locale: 'en-XA',
  catalog: {},
  coverage: 100
}
const defaults = getDefaultSettings('/tmp')
const at = (changes: Partial<GlobalSettings>): GlobalSettings => ({ ...defaults, ...changes })
const settings = at({})
const registered: Parameters<typeof pluginInUse>[2] = {
  appThemes: [theme('acme.pair', 'light'), theme('acme.pair', 'dark'), theme('acme.night', 'dark')],
  terminalThemes: [],
  iconThemes: [{ id: 'plugin:acme.icons/blocks', pluginKey: 'acme.icons', label: 'Blocks' }],
  languagePacks: [pack]
}

describe('pluginInUse', () => {
  it('offers Use while installed but not active', () => {
    expect(pluginInUse('acme.pair', settings, registered)).toEqual({
      kind: 'available',
      languagePack: null
    })
    expect(pluginInUse('acme.xa', settings, registered)).toEqual({
      kind: 'available',
      languagePack: pack
    })
  })

  it('is in use without a slot when a pack fills both slots', () => {
    const both = at({
      pluginAppThemeLight: 'plugin:acme.pair/light',
      pluginAppThemeDark: 'plugin:acme.pair/dark'
    })
    expect(pluginInUse('acme.pair', both, registered)).toEqual({ kind: 'in-use', slot: null })
  })

  it('names the one slot each pack fills when the slots mix two packs', () => {
    const mixed = at({
      pluginAppThemeLight: 'plugin:acme.pair/light',
      pluginAppThemeDark: 'plugin:acme.night/dark'
    })
    expect(pluginInUse('acme.pair', mixed, registered)).toEqual({ kind: 'in-use', slot: 'light' })
    expect(pluginInUse('acme.night', mixed, registered)).toEqual({ kind: 'in-use', slot: 'dark' })
    // Why: the pair's terminal colours still filling both slots don't make its app theme active.
    const withTerminals: Parameters<typeof pluginInUse>[2] = {
      ...registered,
      terminalThemes: (['dark', 'light'] as const).map((mode) => ({
        id: `plugin:acme.pair/term-${mode}`,
        pluginKey: 'acme.pair',
        pluginName: 'acme.pair',
        label: mode,
        mode,
        terminal: {}
      }))
    }
    expect(
      pluginInUse(
        'acme.pair',
        {
          ...mixed,
          terminalThemeDark: 'plugin:acme.pair/term-dark',
          terminalThemeLight: 'plugin:acme.pair/term-light',
          terminalUseSeparateLightTheme: true
        } satisfies GlobalSettings,
        withTerminals
      )
    ).toEqual({ kind: 'in-use', slot: 'light' })
  })

  it('is in use for the active icon theme and interface language', () => {
    const active = at({ pluginIconTheme: 'plugin:acme.icons/blocks', uiLanguage: pack.id })
    expect(pluginInUse('acme.icons', active, registered)).toEqual({ kind: 'in-use', slot: null })
    expect(pluginInUse('acme.xa', active, registered)).toEqual({ kind: 'in-use', slot: null })
  })

  it('offers nothing for a language pack too incomplete to switch to', () => {
    expect(
      pluginInUse('acme.xa', settings, { ...registered, languagePacks: [{ ...pack, coverage: 1 }] })
    ).toBeNull()
  })
})
