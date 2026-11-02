// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../preload/api-types'
import { usePluginPanelsStore } from './plugin-panels'

function plugin(pluginKey: string): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: 'sha256-test',
    name: pluginKey,
    version: '1.0.0',
    publisher: 'samples',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0
  }
}

afterEach(() => {
  usePluginPanelsStore.getState().setPlugins([])
  usePluginPanelsStore.setState({ plugins: [], panelErrors: {}, fetchStatus: 'idle' })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('plugin panel list loading', () => {
  it('bounds watchdog errors to installed panels and clears them on recovery', () => {
    const installed = {
      ...plugin('samples.current'),
      panels: [
        {
          id: 'dashboard',
          title: 'Dashboard',
          tabKey: 'plugin:samples.current/dashboard' as const
        }
      ]
    }
    usePluginPanelsStore.getState().setPlugins([installed])
    usePluginPanelsStore.getState().setPanelHealth('plugin:samples.current/dashboard', 'error')
    expect(usePluginPanelsStore.getState().panelErrors).toEqual({
      'plugin:samples.current/dashboard': true
    })

    usePluginPanelsStore.getState().setPanelHealth('plugin:samples.current/dashboard', 'healthy')
    expect(usePluginPanelsStore.getState().panelErrors).toEqual({})

    usePluginPanelsStore.getState().setPanelHealth('plugin:samples.current/dashboard', 'error')
    usePluginPanelsStore.getState().setPlugins([])
    expect(usePluginPanelsStore.getState().panelErrors).toEqual({})
  })

  it('does not let an older request overwrite a newer plugin list', async () => {
    let resolveFirst!: (plugins: PluginHostListEntry[]) => void
    let resolveSecond!: (plugins: PluginHostListEntry[]) => void
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)))
    vi.stubGlobal('window', { api: { plugins: { list } } })

    const first = usePluginPanelsStore.getState().fetchPlugins()
    const second = usePluginPanelsStore.getState().fetchPlugins()
    resolveSecond([plugin('samples.current')])
    await second
    resolveFirst([plugin('samples.stale')])
    await first

    expect(usePluginPanelsStore.getState().plugins.map((entry) => entry.pluginKey)).toEqual([
      'samples.current'
    ])
  })

  it('recovers automatically from a transient list failure with bounded backoff', async () => {
    vi.useFakeTimers()
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport starting'))
      .mockResolvedValueOnce([plugin('samples.recovered')])
    vi.stubGlobal('window', { api: { plugins: { list } } })

    await usePluginPanelsStore.getState().fetchPlugins()
    expect(usePluginPanelsStore.getState().fetchStatus).toBe('error')

    await vi.advanceTimersByTimeAsync(250)

    expect(list).toHaveBeenCalledTimes(2)
    expect(usePluginPanelsStore.getState()).toMatchObject({
      fetchStatus: 'ready',
      plugins: [expect.objectContaining({ pluginKey: 'samples.recovered' })]
    })
  })
})
