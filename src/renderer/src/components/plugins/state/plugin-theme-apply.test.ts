// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginTerminalThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { useAppStore } from '@/store'
import { applyPluginThemesNow } from './plugin-theme-apply'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
import { toast, type ExternalToast } from 'sonner'

const pluginKey = 'acme.dusk'
const appTheme = (name: string, base: 'dark' | 'light') => ({
  id: `plugin:${pluginKey}/${name}`,
  pluginKey,
  pluginName: 'Dusk & Ember',
  label: name === 'ember' ? 'Ember' : 'Dusk',
  revision: 'r1',
  base,
  tokens: {
    '--background': base === 'dark' ? '#181818' : '#fafafa',
    '--foreground': base === 'dark' ? '#eeeeee' : '#181818'
  }
})
const initialState = useAppStore.getState()

function installApi(lists: { themes?: unknown[]; icons?: unknown[]; terminals?: unknown[] }) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        listThemes: vi.fn().mockResolvedValue(lists.themes ?? []),
        listIconThemes: vi.fn().mockResolvedValue(lists.icons ?? []),
        listTerminalThemes: vi.fn().mockResolvedValue(lists.terminals ?? [])
      }
    }
  })
}

/** Clicks a sonner toast action through a real button, as the toast would. */
function clickToastAction(options: ExternalToast | undefined): void {
  const action = options?.action
  if (!action || typeof action !== 'object' || !('onClick' in action)) {
    return
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(createElement('button', { onClick: action.onClick })))
  act(() => container.querySelector('button')?.click())
  act(() => root.unmount())
}

function switchBack(): void {
  clickToastAction(vi.mocked(toast.success).mock.calls.at(-1)?.[1])
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear()
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), theme: 'light' },
    updateSettings: async (updates: Partial<GlobalSettings>) => {
      const current = useAppStore.getState().settings ?? getDefaultSettings('/tmp')
      useAppStore.setState({ settings: { ...current, ...updates } })
    }
  })
})

afterEach(() => useAppStore.setState(initialState, true))

const darkTerminal: PluginTerminalThemeRegistration = {
  id: `plugin:${pluginKey}/term`,
  pluginKey,
  pluginName: 'Dusk & Ember',
  label: 'Dusk Terminal',
  mode: 'dark',
  terminal: { background: '#181818', foreground: '#eeeeee', red: '#ff0000' }
}

it('Switch back restores every slot exactly', async () => {
  const before = {
    ...useAppStore.getState().settings!,
    pluginAppThemeLight: 'plugin:other.dawn/dawn' as const
  }
  useAppStore.setState({ settings: before })
  installApi({
    themes: [appTheme('dusk', 'dark'), appTheme('ember', 'light')],
    icons: [{ id: `plugin:${pluginKey}/icons`, pluginKey, label: 'Dusk Icons' }],
    terminals: [darkTerminal]
  })
  await applyPluginThemesNow(pluginKey)
  switchBack()
  await vi.waitFor(() =>
    expect(useAppStore.getState().settings).toMatchObject({
      theme: before.theme,
      pluginAppThemeLight: 'plugin:other.dawn/dawn',
      pluginAppThemeDark: null,
      pluginIconTheme: null,
      terminalThemeDark: before.terminalThemeDark,
      terminalThemeLight: before.terminalThemeLight,
      terminalUseSeparateLightTheme: before.terminalUseSeparateLightTheme,
      terminalPluginPalettes: []
    })
  )
})
