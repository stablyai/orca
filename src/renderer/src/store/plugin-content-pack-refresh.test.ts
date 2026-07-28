// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginChangeEvent } from '../../../shared/plugins/plugin-change-event'
import { ensurePluginIconThemesLoaded, usePluginIconThemeStore } from './plugin-icon-themes'
import {
  ensurePluginTerminalThemesLoaded,
  usePluginTerminalThemeStore
} from './plugin-terminal-themes'

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('plugin content-pack refreshes', () => {
  it('loads only the selected icon theme and ignores worker-only notifications', async () => {
    const listeners: ((event: PluginChangeEvent) => void)[] = []
    const metadata = {
      id: 'plugin:acme.icons/main' as const,
      pluginKey: 'acme.icons',
      label: 'Acme'
    }
    const registration = {
      ...metadata,
      icons: {},
      fileNames: {},
      fileExtensions: {
        ts: { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', rendering: 'image' as const }
      }
    }
    const listIconThemes = vi.fn(async () => [metadata])
    const loadIconTheme = vi.fn(async () => registration)
    const listTerminalThemes = vi.fn(async () => [])
    ;(window as unknown as { api: unknown }).api = {
      plugins: {
        listIconThemes,
        loadIconTheme,
        listTerminalThemes,
        onChanged: (listener: (event: PluginChangeEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        }
      }
    }
    usePluginIconThemeStore.setState({
      themes: [],
      activeId: null,
      activeTheme: null,
      loaded: false
    })
    usePluginTerminalThemeStore.setState({ themes: [], loaded: false })

    ensurePluginIconThemesLoaded()
    ensurePluginTerminalThemesLoaded()
    await vi.waitFor(() => expect(listIconThemes).toHaveBeenCalledOnce())
    expect(loadIconTheme).not.toHaveBeenCalled()

    usePluginIconThemeStore.getState().setActiveId(metadata.id)
    await vi.waitFor(() =>
      expect(usePluginIconThemeStore.getState().activeTheme).toEqual(registration)
    )
    expect(loadIconTheme).toHaveBeenCalledOnce()

    for (const listener of listeners) {
      listener({ contentPacksChanged: false })
    }
    await Promise.resolve()
    expect(listIconThemes).toHaveBeenCalledOnce()
    expect(listTerminalThemes).toHaveBeenCalledOnce()

    for (const listener of listeners) {
      listener({ contentPacksChanged: true })
    }
    await vi.waitFor(() => expect(listIconThemes).toHaveBeenCalledTimes(2))
    expect(listTerminalThemes).toHaveBeenCalledTimes(2)
  })
})
