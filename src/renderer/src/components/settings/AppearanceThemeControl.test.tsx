// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AppearanceThemeSlotSelect } from './AppearanceThemeControl'

const themes = vi.hoisted((): { app: unknown[]; terminal: unknown[] } => ({
  app: [],
  terminal: []
}))
vi.mock('@/store/plugin-themes', () => ({
  usePluginThemes: () => themes.app,
  usePluginTerminalThemes: () => themes.terminal
}))

afterEach(() => {
  cleanup()
  themes.app = []
  themes.terminal = []
})

const dusk = {
  id: 'plugin:samples.dusk/dusk',
  pluginKey: 'samples.dusk',
  revision: 'r1',
  pluginName: 'Dusk',
  label: 'Dusk',
  base: 'dark',
  tokens: { '--background': '#1b1430', '--foreground': '#e8e0ff' }
}

it('lists only themes of its mode, grouped by plugin, and offers the plugin terminal colors', async () => {
  themes.app = [
    dusk,
    { ...dusk, id: 'plugin:samples.dusk/dawn', label: 'Dawn', base: 'light' },
    {
      ...dusk,
      id: 'plugin:acme.night/night',
      pluginKey: 'acme.night',
      pluginName: 'Acme',
      label: 'Night'
    }
  ]
  themes.terminal = [
    {
      ...dusk,
      mode: 'dark',
      terminal: { background: '#1b1430', foreground: '#e8e0ff', red: '#f00' }
    }
  ]
  const updateSettings = vi.fn()
  render(
    <AppearanceThemeSlotSelect
      base="dark"
      label="Dark theme"
      settings={{
        ...getDefaultSettings('/tmp'),
        pluginAppThemeDark: 'plugin:samples.dusk/dusk',
        terminalColorOverrides: { red: '#123456' }
      }}
      updateSettings={updateSettings}
    />
  )
  expect(screen.getByRole('combobox', { name: 'Dark theme' }).textContent).toContain('Dusk')
  screen.getByRole('button', { name: 'Use its terminal colors' }).click()
  expect(updateSettings).toHaveBeenCalledWith({
    terminalThemeDark: 'plugin:samples.dusk/dusk',
    terminalPluginPalettes: [
      {
        id: 'plugin:samples.dusk/dusk',
        colors: { background: '#1b1430', foreground: '#e8e0ff', red: '#f00' }
      }
    ]
  })
  // Overrides would otherwise mask the palette the user just chose.
  expect(updateSettings.mock.calls[0]?.[0]).toHaveProperty('terminalColorOverrides', undefined)
  screen.getByRole('combobox', { name: 'Dark theme' }).click()
  expect(await screen.findByText('Acme')).toBeDefined()
  expect(screen.queryByRole('option', { name: 'Dawn' })).toBeNull()
  screen.getByRole('option', { name: 'Night' }).click()
  expect(updateSettings).toHaveBeenLastCalledWith({ pluginAppThemeDark: 'plugin:acme.night/night' })
})

it('returns a slot to the built-in colors', async () => {
  themes.app = [dusk]
  const updateSettings = vi.fn()
  render(
    <AppearanceThemeSlotSelect
      base="dark"
      label="Dark theme"
      settings={{ ...getDefaultSettings('/tmp'), pluginAppThemeDark: 'plugin:samples.dusk/dusk' }}
      updateSettings={updateSettings}
    />
  )
  screen.getByRole('combobox', { name: 'Dark theme' }).click()
  ;(await screen.findByRole('option', { name: 'Built-in' })).click()
  expect(updateSettings).toHaveBeenCalledWith({ pluginAppThemeDark: null })
})
