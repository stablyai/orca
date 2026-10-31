// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizePluginThemeSettings } from '../../../../../shared/plugin-theme-settings'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import type { PluginIconThemeMetadata } from '../../../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  resolveConfiguredTerminalColors,
  selectTerminalTheme
} from '../../../../../shared/terminal-theme-selection'
import { useAppStore } from '@/store'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { resolveMobileTerminalTheme } from '@/runtime/sync-runtime-graph/mobile-terminal-theme'
import { PluginThemeUseNow } from './PluginThemeUseNow'

const state = vi.hoisted(
  (): {
    app: PluginThemeRegistration[]
    terminal: PluginTerminalThemeRegistration[]
    icons: PluginIconThemeMetadata[]
  } => ({ app: [], terminal: [], icons: [] })
)
vi.mock('@/store/plugin-themes', () => ({
  usePluginThemes: () => state.app,
  usePluginTerminalThemes: () => state.terminal
}))
vi.mock('@/store/plugin-icon-themes', () => ({ usePluginIconThemes: () => state.icons }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const pluginKey = 'samples.theme'
const id = 'plugin:samples.theme/dusk'
const initialState = useAppStore.getState()
let saved = getDefaultSettings('/tmp')
let systemDark = true
let appearanceChanged: ((event: { matches: boolean }) => void) | undefined
const settingsSet = vi.fn<(updates: Partial<GlobalSettings>) => Promise<GlobalSettings>>()
function settings(): GlobalSettings {
  const current = useAppStore.getState().settings
  if (!current) {
    throw new Error('Expected loaded settings')
  }
  return current
}
function load(updates: Partial<GlobalSettings> = {}): void {
  saved = { ...getDefaultSettings('/tmp'), theme: 'dark', ...updates }
  useAppStore.setState({ settings: saved })
}
function changeSystem(dark: boolean): void {
  systemDark = dark
  act(() => appearanceChanged?.({ matches: dark }))
}
async function choose(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}
beforeEach(() => {
  load()
  systemDark = true
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: systemDark,
      addEventListener: (_type: string, listener: typeof appearanceChanged) => {
        appearanceChanged = listener
      },
      removeEventListener: () => {
        appearanceChanged = undefined
      }
    })
  })
  settingsSet.mockReset().mockImplementation(async (updates) => {
    saved = { ...saved, ...updates, ...normalizePluginThemeSettings(updates) }
    return saved
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { set: settingsSet } }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  state.app = []
  state.terminal = []
  state.icons = []
  toast.success.mockClear()
  toast.error.mockClear()
})

const appTheme = (name: string, base: 'dark' | 'light'): PluginThemeRegistration => ({
  id: `plugin:${pluginKey}/${name.toLowerCase()}`,
  pluginKey,
  pluginName: 'Dusk',
  label: name,
  revision: 'r1',
  base,
  tokens: { '--background': '#181818', '--foreground': '#eeeeee' }
})
const terminalTheme = (
  name: string,
  mode: PluginTerminalThemeRegistration['mode']
): PluginTerminalThemeRegistration => ({
  id: `plugin:${pluginKey}/${name.toLowerCase()}`,
  pluginKey,
  pluginName: 'Dusk',
  label: name,
  mode,
  terminal: { background: '#181818', foreground: '#eeeeee', red: '#ff0000' }
})

it.each([6, 60])('prepares only the clicked terminal palette among %i choices', async (count) => {
  state.terminal = Array.from({ length: count }, (_, index) =>
    terminalTheme(
      `Choice${index}`,
      index === count - 1 ? 'unknown' : index === 0 ? 'light' : 'dark'
    )
  )
  const candidate = state.terminal[count - 1]
  load({
    theme: 'system',
    terminalUseSeparateLightTheme: false,
    terminalColorOverrides: { background: '#123456' }
  })
  const before = settings()
  let visits = 0
  const originalFind = state.terminal.find
  const lookup = vi.spyOn(state.terminal, 'find').mockImplementation((predicate, thisArg) =>
    originalFind.call(state.terminal, (entry, index, array) => {
      visits++
      return predicate.call(thisArg, entry, index, array)
    })
  )
  let acknowledge: () => void = () => {}
  settingsSet.mockImplementationOnce(
    (updates) =>
      new Promise((resolve) => {
        acknowledge = () => {
          saved = { ...saved, ...updates, ...normalizePluginThemeSettings(updates) }
          resolve(saved)
        }
      })
  )
  try {
    render(<PluginThemeUseNow pluginKey={pluginKey} />)
    expect(screen.getAllByRole('button')).toHaveLength(count)
    expect(visits).toBe(0)
    expect(settingsSet).not.toHaveBeenCalled()
    act(() => load({ ...settings(), terminalFontSize: 17 }))
    expect(visits).toBe(0)
    expect(settingsSet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: `Use now: ${candidate.label}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use for light: Choice0' })).toBeTruthy()
    changeSystem(false)
    expect(screen.getByRole('button', { name: 'Use now: Choice0' })).toBeTruthy()
    expect(visits).toBe(0)
    expect(settingsSet).not.toHaveBeenCalled()

    await choose(`Use now: ${candidate.label}`)
    const clickedVisits = visits
    expect(clickedVisits).toBeGreaterThan(0)
    expect(clickedVisits).toBeLessThanOrEqual(2 * count)
    expect(settingsSet).toHaveBeenCalledTimes(1)
    const update = settingsSet.mock.calls[0][0]
    expect(update).toMatchObject({
      terminalThemeLight: candidate.id,
      terminalUseSeparateLightTheme: true,
      terminalPluginPalettes: [{ id: candidate.id, colors: candidate.terminal }]
    })
    expect(update).toHaveProperty('terminalColorOverrides', undefined)
    expect(update).not.toHaveProperty('theme')
    expect(settings().terminalThemeLight).toBe(before.terminalThemeLight)
    expect(
      screen
        .getByRole('button', { name: `Use now: ${candidate.label}` })
        .getAttribute('aria-pressed')
    ).toBe('false')
    expect(toast.success).not.toHaveBeenCalled()
    changeSystem(true)
    expect(visits).toBe(clickedVisits)
    expect(settingsSet).toHaveBeenCalledTimes(1)
    expect(update.terminalThemeLight).toBe(candidate.id)
    await act(async () => acknowledge())
    expect(settings()).toMatchObject({
      theme: 'system',
      terminalThemeDark: before.terminalThemeDark,
      terminalThemeLight: candidate.id,
      terminalUseSeparateLightTheme: true
    })
    expect(visits).toBe(clickedVisits)
    changeSystem(false)
    expect(
      screen
        .getByRole('button', { name: `Use now: ${candidate.label}` })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(resolveEffectiveTerminalAppearance(settings(), false).theme).toMatchObject(
      candidate.terminal
    )
    expect(visits).toBe(clickedVisits)
    act(() => load({ ...settings(), terminalFontSize: 18 }))
    expect(visits).toBe(clickedVisits)
    expect(settingsSet).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    console.info(
      `terminal palette contract N=M=${count}: render=0, click=${clickedVisits}, pending/ack/later=0, writes=1`
    )
  } finally {
    lookup.mockRestore()
  }
})

it('fills only the slot of the theme it was asked for', async () => {
  state.app = [appTheme('Dusk', 'dark')]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(settingsSet).not.toHaveBeenCalled()
  await choose('Use now: Dusk')
  expect(settings().pluginAppThemeDark).toBe(`plugin:${pluginKey}/dusk`)
  expect(settings().theme).toBe('dark')
  expect(toast.success).not.toHaveBeenCalled()
})

it.each([
  ['dark', true, 'light'],
  ['light', false, 'dark'],
  ['system', true, 'light'],
  ['system', false, 'dark']
] as const)(
  'keeps %s appearance (OS dark=%s) and acknowledges the assigned %s slot',
  async (theme, osDark, base) => {
    load({ theme })
    systemDark = osDark
    state.app = [appTheme('Choice', base)]
    let acknowledge: (settings: GlobalSettings) => void = () => {}
    settingsSet.mockImplementationOnce(
      (updates) =>
        new Promise((resolve) => {
          acknowledge = (current) => {
            saved = { ...current, ...updates, ...normalizePluginThemeSettings(updates) }
            resolve(saved)
          }
        })
    )
    render(<PluginThemeUseNow pluginKey={pluginKey} />)
    await choose(`Use for ${base}: Choice`)
    expect(settings().pluginAppThemeLight).toBeNull()
    expect(settings().pluginAppThemeDark).toBeNull()
    expect(toast.success).not.toHaveBeenCalled()
    if (theme === 'system') {
      changeSystem(!osDark)
      expect(
        screen.getByRole('button', { name: 'Use now: Choice' }).getAttribute('aria-pressed')
      ).toBe('false')
    }
    await act(async () => acknowledge(saved))
    expect(settings().theme).toBe(theme)
    expect(settings()[base === 'light' ? 'pluginAppThemeLight' : 'pluginAppThemeDark']).toBe(
      state.app[0].id
    )
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(`Choice set as your ${base} theme`)
  }
)

it.each(['light', 'dark'] as const)(
  'reports rejected %s assignments once without publishing or undo',
  async (base) => {
    state.app = [appTheme('Choice', base)]
    settingsSet.mockRejectedValueOnce(new Error('write failed'))
    render(<PluginThemeUseNow pluginKey={pluginKey} />)
    const before = settings()
    await choose(`${base === 'dark' ? 'Use now:' : 'Use for light:'} Choice`)
    expect(settings()).toBe(before)
    expect(settingsSet).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not save the theme. Try again.')
  }
)

it('keeps app and terminal kind cues when identically named chips are selected', async () => {
  state.app = [appTheme('Dusk', 'dark'), appTheme('Night', 'dark')]
  state.terminal = [terminalTheme('Dusk', 'dark')]
  load({ pluginAppThemeDark: state.app[0].id })
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  const [app, terminal] = screen.getAllByRole('button', { name: 'Use now: Dusk' })
  expect(app.getAttribute('aria-pressed')).toBe('true')
  expect(app.querySelector('span[aria-hidden]')).not.toBeNull()
  await act(async () => {
    fireEvent.click(terminal)
  })
  expect(terminal.getAttribute('aria-pressed')).toBe('true')
  expect(terminal.querySelector('.lucide-square-terminal')).not.toBeNull()
  expect(terminal.querySelector('.lucide-check')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Use now: Night' }).getAttribute('data-variant')).toBe(
    'outline'
  )
})

it('offers an installed icon theme without selecting it until asked', async () => {
  state.icons = [
    { id, pluginKey, label: 'Dusk Icons' },
    { id: 'plugin:other.theme/icons', pluginKey: 'other.theme', label: 'Other Icons' }
  ]
  render(<PluginThemeUseNow pluginKey={pluginKey} />)
  expect(settingsSet).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Other Icons' })).toBeNull()
  await choose('Use now: Dusk Icons')
  expect(settings().pluginIconTheme).toBe(id)
})

it.each([
  ['dark', false, 'dark', 'Use now:'],
  ['dark', false, 'light', 'Use for light:'],
  ['light', false, 'dark', 'Use now:'],
  ['light', true, 'dark', 'Use for dark:'],
  ['light', false, 'light', 'Use now:'],
  ['light', false, 'unknown', 'Use now:']
] as const)(
  'assigns %s/separate=%s/%s by prospective consumer applicability',
  async (theme, separate, nominal, prefix) => {
    load({ theme, terminalUseSeparateLightTheme: separate })
    const old = terminalTheme('Old', 'dark')
    const next = terminalTheme('Next', nominal)
    state.terminal = [old, next]
    if (theme === 'light' && !separate && nominal === 'dark') {
      load({ theme, terminalThemeDark: old.id, terminalUseSeparateLightTheme: false })
    }
    render(<PluginThemeUseNow pluginKey={pluginKey} />)
    if (settings().terminalThemeDark === old.id) {
      expect(
        screen.getByRole('button', { name: 'Use now: Old' }).getAttribute('aria-pressed')
      ).toBe('true')
    }
    const chip = screen.getByRole('button', { name: `${prefix} Next` })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    await choose(`${prefix} Next`)
    expect(settings().theme).toBe(theme)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    const showsNow = prefix === 'Use now:'
    expect(selectTerminalTheme(settings(), systemDark).themeName === next.id).toBe(showsNow)
    if (showsNow) {
      expect(resolveEffectiveTerminalAppearance(settings(), systemDark).theme).toMatchObject(
        next.terminal
      )
    } else {
      expect(toast.success).toHaveBeenCalledExactlyOnceWith(
        `Next set as your ${theme === 'dark' ? 'light' : 'dark'} theme`
      )
    }
    if (showsNow) {
      expect(toast.success).not.toHaveBeenCalled()
    }
    if (nominal === 'dark') {
      expect(settings().terminalUseSeparateLightTheme).toBe(separate)
    } else {
      expect(settings().terminalUseSeparateLightTheme).toBe(true)
    }
  }
)

it.each([
  ['dark', false, 'light'],
  ['light', true, 'dark'],
  ['light', false, 'light']
] as const)(
  'reselects an installed opposite-nominal binding in %s/separate=%s',
  async (theme, separate, nominal) => {
    const installed = terminalTheme('Installed', nominal)
    state.terminal = [installed]
    const slot = theme === 'light' && separate ? 'terminalThemeLight' : 'terminalThemeDark'
    load({ theme, terminalUseSeparateLightTheme: separate, [slot]: installed.id })
    const before = settings()
    render(<PluginThemeUseNow pluginKey={pluginKey} />)
    expect(
      screen.getByRole('button', { name: 'Use now: Installed' }).getAttribute('aria-pressed')
    ).toBe('true')
    await choose('Use now: Installed')
    expect(settings()).toMatchObject({
      theme,
      terminalUseSeparateLightTheme: separate,
      terminalThemeLight: before.terminalThemeLight,
      terminalThemeDark: before.terminalThemeDark
    })
    expect(resolveEffectiveTerminalAppearance(settings(), systemDark).theme).toMatchObject(
      installed.terminal
    )
    expect(toast.success).not.toHaveBeenCalled()
  }
)

it("keeps later choices, and a disabled plugin's other-slot colors for re-enable, across terminal, phone and OSC consumers, without chip rollback", async () => {
  const light = terminalTheme('Light', 'light')
  const later = terminalTheme('Later', 'light')
  const dark: PluginTerminalThemeRegistration = {
    ...terminalTheme('Dark', 'dark'),
    id: 'plugin:other.theme/dark',
    pluginKey: 'other.theme'
  }
  dark.terminal = { background: '#121212', foreground: '#dddddd', red: '#ff2222' }
  state.terminal = [light, later, dark]
  const view = render(<PluginThemeUseNow pluginKey={pluginKey} />)
  await choose('Use for light: Light')
  await choose('Use for light: Later')
  view.rerender(<PluginThemeUseNow pluginKey={dark.pluginKey} />)
  await choose('Use now: Dark')
  act(() => load({ ...settings(), disabledPlugins: [dark.pluginKey] }))
  state.terminal = [light, later]
  view.rerender(<PluginThemeUseNow pluginKey={pluginKey} />)
  await choose('Use for light: Light')
  expect(settings()).toMatchObject({
    theme: 'dark',
    terminalThemeLight: light.id,
    terminalThemeDark: dark.id
  })
  const defaultDark = getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK)
  if (!defaultDark) {
    throw new Error('missing default dark terminal theme')
  }
  // Disabled plugin's slot shows the default; re-enabling restores the saved palette.
  for (const [osDark, enabled] of [
    [true, false],
    [false, false],
    [true, true]
  ] as const) {
    const current = {
      ...settings(),
      theme: 'system' as const,
      disabledPlugins: enabled ? [] : [dark.pluginKey]
    }
    const expected = osDark ? (enabled ? dark.terminal : defaultDark) : light.terminal
    expect(resolveEffectiveTerminalAppearance(current, osDark).theme).toMatchObject(expected)
    expect(resolveConfiguredTerminalColors(current, osDark)).toEqual({
      background: expected.background,
      foreground: expected.foreground
    })
    expect(
      resolveMobileTerminalTheme({ ...useAppStore.getState(), settings: current }, osDark)?.theme
        .red
    ).toBe(expected.red)
  }
  expect(settingsSet).toHaveBeenCalledTimes(4)
  expect(toast.success.mock.calls.every((call) => call.length === 1)).toBe(true)
  expect(toast.error).not.toHaveBeenCalled()
})
