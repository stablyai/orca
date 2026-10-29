// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AppearanceThemeControl } from './AppearanceThemeControl'

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

it('keeps the System/Dark/Light segments until a plugin offers a theme', () => {
  render(
    <AppearanceThemeControl
      label="Theme"
      settings={getDefaultSettings('/tmp')}
      updateSettings={vi.fn()}
      applyTheme={vi.fn()}
    />
  )
  expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeDefined()
})

it('lists plugin themes in the one Theme select and offers the plugin terminal colors', () => {
  themes.app = [dusk]
  themes.terminal = [
    {
      ...dusk,
      mode: 'dark',
      terminal: { background: '#1b1430', foreground: '#e8e0ff', red: '#f00' }
    }
  ]
  const updateSettings = vi.fn()
  render(
    <AppearanceThemeControl
      label="Theme"
      settings={{
        ...getDefaultSettings('/tmp'),
        theme: 'dark',
        pluginAppTheme: 'plugin:samples.dusk/dusk',
        terminalColorOverrides: { red: '#123456' }
      }}
      updateSettings={updateSettings}
      applyTheme={vi.fn()}
    />
  )
  expect(screen.getByRole('combobox', { name: 'Theme' }).textContent).toContain('Dusk')
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
})

it('remembers the built-in choice and names the publisher when theme names collide', async () => {
  themes.app = [
    dusk,
    { ...dusk, id: 'plugin:acme.dusk/dusk', pluginKey: 'acme.dusk', pluginName: 'Acme Dusk' }
  ]
  const updateSettings = vi.fn()
  render(
    <AppearanceThemeControl
      label="Theme"
      settings={{ ...getDefaultSettings('/tmp'), theme: 'system' }}
      updateSettings={updateSettings}
      applyTheme={vi.fn()}
    />
  )
  screen.getByRole('combobox', { name: 'Theme' }).click()
  const option = await screen.findByRole('option', { name: 'Dusk · acme' })
  option.click()
  expect(updateSettings).toHaveBeenCalledWith({
    theme: 'dark',
    pluginAppTheme: 'plugin:acme.dusk/dusk',
    themeBeforePlugin: 'system'
  })
})
