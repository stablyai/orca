// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type * as DocumentTheme from '@/lib/document-theme'
import { useAppStore } from '@/store'
import { applyPluginThemesNow } from './plugin-theme-apply'

const mocks = vi.hoisted(() => ({ applyDocumentTheme: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/lib/document-theme', async (original) => ({
  ...(await original<typeof DocumentTheme>()),
  applyDocumentTheme: mocks.applyDocumentTheme
}))
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
  mocks.applyDocumentTheme.mockClear()
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), theme: 'light' },
    updateSettings: async (updates: Partial<GlobalSettings>) => {
      const current = useAppStore.getState().settings ?? getDefaultSettings('/tmp')
      useAppStore.setState({ settings: { ...current, ...updates } })
    }
  })
})

afterEach(() => useAppStore.setState(initialState, true))

it('applies the app theme matching the current mode plus icon and terminal themes', async () => {
  installApi({
    themes: [appTheme('dusk', 'dark'), appTheme('ember', 'light')],
    icons: [{ id: `plugin:${pluginKey}/icons`, pluginKey, label: 'Dusk Icons' }],
    terminals: [
      {
        id: `plugin:${pluginKey}/term`,
        pluginKey,
        pluginName: 'Dusk & Ember',
        label: 'Ember Terminal',
        mode: 'light',
        terminal: { background: '#fafafa', foreground: '#181818', red: '#ff0000' }
      }
    ]
  })
  expect(await applyPluginThemesNow(pluginKey)).toBe(true)
  const settings = useAppStore.getState().settings!
  expect(settings).toMatchObject({
    theme: 'light',
    pluginAppTheme: `plugin:${pluginKey}/ember`,
    themeBeforePlugin: 'light',
    pluginIconTheme: `plugin:${pluginKey}/icons`,
    terminalThemeLight: `plugin:${pluginKey}/term`,
    terminalUseSeparateLightTheme: true
  })
  expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith('light')
  expect(toast.success).toHaveBeenCalledWith('Now using Ember', {
    action: { label: 'Switch back', onClick: expect.any(Function) }
  })
})

it('Switch back restores the earlier app, icon and terminal choices exactly', async () => {
  const before = useAppStore.getState().settings!
  installApi({
    themes: [appTheme('dusk', 'dark')],
    icons: [{ id: `plugin:${pluginKey}/icons`, pluginKey, label: 'Dusk Icons' }],
    terminals: [
      {
        id: `plugin:${pluginKey}/term`,
        pluginKey,
        pluginName: 'Dusk & Ember',
        label: 'Dusk Terminal',
        mode: 'dark',
        terminal: { background: '#181818', foreground: '#eeeeee', red: '#ff0000' }
      }
    ]
  })
  await applyPluginThemesNow(pluginKey)
  expect(useAppStore.getState().settings?.theme).toBe('dark')
  switchBack()
  await vi.waitFor(() =>
    expect(useAppStore.getState().settings).toMatchObject({
      theme: before.theme,
      pluginAppTheme: null,
      themeBeforePlugin: null,
      pluginIconTheme: null,
      terminalThemeDark: before.terminalThemeDark,
      terminalThemeLight: before.terminalThemeLight,
      terminalUseSeparateLightTheme: before.terminalUseSeparateLightTheme,
      terminalPluginPalettes: []
    })
  )
  expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith(before.theme)
})

it('changes nothing for a plugin that adds no theme', async () => {
  installApi({ themes: [{ ...appTheme('dusk', 'dark'), pluginKey: 'other.plugin' }] })
  const before = useAppStore.getState().settings
  expect(await applyPluginThemesNow(pluginKey)).toBe(false)
  expect(useAppStore.getState().settings).toBe(before)
  expect(toast.success).not.toHaveBeenCalled()
})
