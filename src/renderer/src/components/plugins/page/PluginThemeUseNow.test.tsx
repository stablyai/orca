// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import type { PluginIconThemeMetadata } from '../../../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import { PluginThemeUseNow } from './PluginThemeUseNow'

const state = vi.hoisted(
  (): {
    app: PluginThemeRegistration[]
    terminal: PluginTerminalThemeRegistration[]
    icons: PluginIconThemeMetadata[]
    settings: GlobalSettings | null
    updateSettings: ReturnType<typeof vi.fn>
  } => ({
    app: [],
    terminal: [],
    icons: [],
    settings: null,
    updateSettings: vi.fn().mockResolvedValue(undefined)
  })
)
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/store/plugin-themes', () => ({
  usePluginThemes: () => state.app,
  usePluginTerminalThemes: () => state.terminal
}))
vi.mock('@/store/plugin-icon-themes', () => ({ usePluginIconThemes: () => state.icons }))
vi.mock('@/lib/document-theme', () => ({
  applyDocumentTheme: vi.fn(),
  resolveDocumentTheme: () => true
}))

const pluginKey = 'samples.theme'
const id = 'plugin:samples.theme/dusk'
afterEach(() => {
  cleanup()
  state.app = []
  state.terminal = []
  state.icons = []
  state.settings = null
  state.updateSettings.mockClear()
})

it('applies an app theme only when asked and remembers the previous appearance', () => {
  state.settings = { ...getDefaultSettings('/tmp'), theme: 'light' }
  state.app = [
    {
      id,
      pluginKey,
      pluginName: 'Dusk',
      label: 'Dusk',
      revision: 'r1',
      base: 'dark',
      tokens: { '--background': '#181818', '--foreground': '#eeeeee' }
    }
  ]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(state.updateSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use now: Dusk' }))
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    theme: 'dark',
    pluginAppTheme: id,
    themeBeforePlugin: 'light'
  })
})

it('offers an installed icon theme without selecting it until asked', () => {
  state.settings = getDefaultSettings('/tmp')
  state.icons = [
    { id, pluginKey, label: 'Dusk Icons' },
    { id: 'plugin:other.theme/icons', pluginKey: 'other.theme', label: 'Other Icons' }
  ]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(state.updateSettings).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Other Icons' })).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Use now: Dusk Icons' }).getAttribute('data-variant')
  ).toBe('default')
  fireEvent.click(screen.getByRole('button', { name: 'Use now: Dusk Icons' }))
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({ pluginIconTheme: id })
})

it.each(['dark', 'light', 'unknown'] as const)(
  'offers an installed %s terminal theme and saves its palette only when asked',
  (mode) => {
    state.settings = getDefaultSettings('/tmp')
    const terminal = { background: '#181818', foreground: '#eeeeee', red: '#ff0000' }
    state.terminal = [{ id, pluginKey, pluginName: 'Dusk', label: 'Dusk Terminal', mode, terminal }]
    render(<PluginThemeUseNow pluginKey={pluginKey} />)
    expect(state.updateSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use now: Dusk Terminal' }))
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      ...(mode === 'light'
        ? { terminalThemeLight: id, terminalUseSeparateLightTheme: true }
        : { terminalThemeDark: id }),
      terminalPluginPalettes: [{ id, colors: terminal }]
    })
  }
)

it('marks selected icon and terminal themes without changing app appearance', () => {
  state.settings = { ...getDefaultSettings('/tmp'), pluginIconTheme: id, terminalThemeDark: id }
  state.icons = [{ id, pluginKey, label: 'Dusk Icons' }]
  state.terminal = [
    {
      id,
      pluginKey,
      pluginName: 'Dusk',
      label: 'Dusk Terminal',
      mode: 'dark',
      terminal: { background: '#181818', foreground: '#eeeeee', red: '#ff0000' }
    }
  ]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(
    screen.getByRole('button', { name: 'Use now: Dusk Icons' }).getAttribute('aria-pressed')
  ).toBe('true')
  expect(
    screen.getByRole('button', { name: 'Use now: Dusk Terminal' }).getAttribute('aria-pressed')
  ).toBe('true')
  expect(state.updateSettings).not.toHaveBeenCalled()
})
