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
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/store/plugin-themes', () => ({
  usePluginThemes: () => state.app,
  usePluginTerminalThemes: () => state.terminal
}))
vi.mock('@/store/plugin-icon-themes', () => ({ usePluginIconThemes: () => state.icons }))
vi.mock('@/lib/document-theme', () => ({
  resolveDocumentTheme: (theme: string) => theme !== 'light'
}))
const toast = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const pluginKey = 'samples.theme'
const id = 'plugin:samples.theme/dusk'
afterEach(() => {
  cleanup()
  state.app = []
  state.terminal = []
  state.icons = []
  state.settings = null
  state.updateSettings.mockClear()
  toast.success.mockClear()
})

const appTheme = (name: string, base: 'dark' | 'light'): PluginThemeRegistration => ({
  id: `plugin:${pluginKey}/${name}`,
  pluginKey,
  pluginName: 'Dusk',
  label: name,
  revision: 'r1',
  base,
  tokens: { '--background': '#181818', '--foreground': '#eeeeee' }
})

it('fills only the slot of the theme it was asked for', () => {
  state.settings = { ...getDefaultSettings('/tmp'), theme: 'dark' }
  state.app = [appTheme('Dusk', 'dark')]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(state.updateSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use now: Dusk' }))
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    pluginAppThemeDark: `plugin:${pluginKey}/Dusk`
  })
  expect(toast.success).not.toHaveBeenCalled()
})

it('switches to the mode of a theme picked for the other mode, with a way back', () => {
  state.settings = { ...getDefaultSettings('/tmp'), theme: 'dark' }
  state.app = [appTheme('Dusk', 'dark'), appTheme('Dawn', 'light')]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(screen.getByText('Use for light:')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Use for light: Dawn' }))
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    pluginAppThemeLight: `plugin:${pluginKey}/Dawn`,
    theme: 'light'
  })
  expect(toast.success).toHaveBeenCalledExactlyOnceWith(
    'Now using Dawn',
    expect.objectContaining({ action: expect.objectContaining({ label: 'Switch back' }) })
  )
})

it('switches back only the settings the pick changed', () => {
  state.settings = {
    ...getDefaultSettings('/tmp'),
    theme: 'dark',
    pluginAppThemeLight: 'plugin:previous/light',
    pluginIconTheme: 'plugin:previous/icons'
  }
  state.app = [appTheme('Dawn', 'light')]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  fireEvent.click(screen.getByRole('button', { name: 'Use for light: Dawn' }))
  const action: { onClick: () => void } = toast.success.mock.calls[0]?.[1]?.action
  action.onClick()
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    pluginAppThemeLight: 'plugin:previous/light',
    theme: 'dark'
  })
})

it('fills the selected chip and outlines the others', () => {
  state.settings = {
    ...getDefaultSettings('/tmp'),
    theme: 'dark',
    pluginAppThemeDark: `plugin:${pluginKey}/Dusk`
  }
  state.app = [appTheme('Dusk', 'dark'), appTheme('Night', 'dark')]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  const dusk = screen.getByRole('button', { name: 'Use now: Dusk' })
  expect(dusk.getAttribute('aria-pressed')).toBe('true')
  expect(dusk.getAttribute('data-variant')).toBe('default')
  expect(screen.getByRole('button', { name: 'Use now: Night' }).getAttribute('data-variant')).toBe(
    'outline'
  )
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
    // Why "Use for light": the tests render dark mode, where a light terminal theme waits.
    const prefix = mode === 'light' ? 'Use for light:' : 'Use now:'
    fireEvent.click(screen.getByRole('button', { name: `${prefix} Dusk Terminal` }))
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      ...(mode === 'light'
        ? { terminalThemeLight: id, terminalUseSeparateLightTheme: true, theme: 'light' }
        : { terminalThemeDark: id }),
      terminalPluginPalettes: [{ id, colors: terminal }]
    })
  }
)

it('lists a lone terminal theme the install put in the showing slot under "Use now"', () => {
  const terminal = { background: '#ffffff', foreground: '#111111', red: '#ff0000' }
  state.settings = { ...getDefaultSettings('/tmp'), theme: 'dark', terminalThemeDark: id }
  state.terminal = [
    { id, pluginKey, pluginName: 'Dusk', label: 'Dusk Terminal', mode: 'light', terminal }
  ]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(screen.queryByText('Use for light:')).toBeNull()
  const chip = screen.getByRole('button', { name: 'Use now: Dusk Terminal' })
  expect(chip.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(chip)
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    terminalThemeDark: id,
    terminalPluginPalettes: [{ id, colors: terminal }]
  })
  expect(toast.success).not.toHaveBeenCalled()
})

it('lists the dark terminal theme light mode shows with Match dark mode under "Use now"', () => {
  const terminal = { background: '#181818', foreground: '#eeeeee', red: '#ff0000' }
  state.settings = {
    ...getDefaultSettings('/tmp'),
    theme: 'light',
    terminalUseSeparateLightTheme: false,
    terminalThemeDark: id
  }
  state.terminal = [
    { id, pluginKey, pluginName: 'Dusk', label: 'Dusk Terminal', mode: 'dark', terminal }
  ]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(screen.queryByText('Use for dark:')).toBeNull()
  const chip = screen.getByRole('button', { name: 'Use now: Dusk Terminal' })
  expect(chip.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(chip)
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    terminalThemeDark: id,
    terminalPluginPalettes: [{ id, colors: terminal }]
  })
  expect(toast.success).not.toHaveBeenCalled()
})
