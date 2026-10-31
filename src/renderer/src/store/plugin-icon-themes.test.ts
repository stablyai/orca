// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginChangeEvent } from '../../../shared/plugins/events/plugin-change-event'

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
    fileExtensions: {},
    folderNames: { src: 0, broken: 1 },
    folderNamesExpanded: { src: 0, broken: 1 }
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
  // The unusable second SVG gets no rule, so its mappings fall back to the built-in icon.
  await waitFor(() =>
    expect(store.useActivePluginIconTheme.getState().theme).toEqual({
      icons: { folder: 0 },
      fileNames: {},
      fileExtensions: {},
      folderNames: { src: 0 },
      folderNamesExpanded: { src: 0 }
    })
  )

  listed = []
  act(() => listeners.forEach((listener) => listener({ contentPacksChanged: true })))
  await waitFor(() => expect(store.useActivePluginIconTheme.getState().theme).toBeNull())
  expect(document.getElementById('orca-plugin-icon-theme')).toBeNull()
})

it('drops the previous icons when the next selected theme fails to load', async () => {
  const working = { id: 'plugin:samples.icons/working', pluginKey: 'samples.icons', label: 'A' }
  const broken = { id: 'plugin:samples.icons/broken', pluginKey: 'samples.icons', label: 'B' }
  vi.stubGlobal('api', {
    plugins: {
      listIconThemes: async () => [working, broken],
      loadIconTheme: vi.fn(async (id: string) =>
        id === working.id
          ? {
              ...working,
              svgs: ['<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor"/></svg>'],
              icons: { file: 0 },
              fileNames: {},
              fileExtensions: {},
              folderNames: {},
              folderNamesExpanded: {}
            }
          : null
      ),
      onChanged: () => () => {}
    }
  })
  const store = await import('./plugin-icon-themes')

  const { rerender } = renderHook(({ id }) => store.usePluginIconThemeActivation(id), {
    initialProps: { id: working.id }
  })
  await waitFor(() => expect(document.getElementById('orca-plugin-icon-theme')).not.toBeNull())
  rerender({ id: broken.id })
  await waitFor(() => expect(document.getElementById('orca-plugin-icon-theme')).toBeNull())
  expect(store.useActivePluginIconTheme.getState().theme).toBeNull()
})
