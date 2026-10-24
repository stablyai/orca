// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginChangeEvent } from '../../../shared/plugins/plugin-change-event'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('loads the selected icon theme and drops it when its plugin goes away', async () => {
  const metadata = {
    id: 'plugin:samples.icons/minimal',
    pluginKey: 'samples.icons',
    label: 'Minimal'
  }
  const theme = {
    ...metadata,
    svgs: [
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1" fill="currentColor"/></svg>',
      '<html/>'
    ],
    icons: { folder: 0, file: 1 },
    fileNames: {},
    fileExtensions: {}
  }
  let listed = [metadata]
  const listeners: ((event: PluginChangeEvent) => void)[] = []
  const loadIconTheme = vi.fn(async () => theme)
  vi.stubGlobal('api', {
    plugins: {
      listIconThemes: async () => listed,
      loadIconTheme,
      onChanged: (listener: (event: PluginChangeEvent) => void) => {
        listeners.push(listener)
        return () => {}
      }
    }
  })
  const store = await import('./plugin-icon-themes')

  renderHook(() => store.usePluginIconThemeActivation(metadata.id))
  // The unusable second SVG gets no rule, so its slot falls back to the built-in icon.
  await waitFor(() =>
    expect(store.useActivePluginIconTheme.getState().theme).toEqual({
      icons: { folder: 0 },
      fileNames: {},
      fileExtensions: {}
    })
  )
  const rules = document.getElementById('orca-plugin-icon-theme')?.textContent ?? ''
  expect(rules).toContain('[data-plugin-icon="0"]')
  expect(rules).toContain('mask:')
  expect(rules).not.toContain('[data-plugin-icon="1"]')
  expect(loadIconTheme).toHaveBeenCalledWith(metadata.id)

  listed = []
  act(() => listeners.forEach((listener) => listener({ contentPacksChanged: true })))
  await waitFor(() => expect(store.useActivePluginIconTheme.getState().theme).toBeNull())
  expect(document.getElementById('orca-plugin-icon-theme')).toBeNull()
})
