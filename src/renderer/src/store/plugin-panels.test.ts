// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../preload/api-types'
import {
  collectActivePluginCommands,
  collectEditablePluginCommands,
  usePluginPanelsStore
} from './plugin-panels'

function plugin(pluginKey: string): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: 'sha256-test',
    name: pluginKey,
    version: '1.0.0',
    publisher: 'orca-samples',
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
  it('collects commands only from enabled plugin states', () => {
    const enabled = {
      ...plugin('orca-samples.enabled'),
      commands: [
        {
          id: 'tasks',
          title: 'Tasks',
          context: 'global' as const,
          handler: { type: 'built-in' as const, action: 'view.tasks' },
          keybindings: [{ key: 'Mod+Alt+T', when: 'global' as const }]
        }
      ]
    }
    const pending = { ...enabled, pluginKey: 'orca-samples.pending', status: 'pending' as const }

    expect(collectActivePluginCommands([enabled, pending])).toEqual([
      expect.objectContaining({
        pluginKey: enabled.pluginKey,
        pluginName: enabled.name,
        id: 'tasks'
      })
    ])
    expect(
      collectEditablePluginCommands([
        { ...enabled, status: 'errored' },
        pending,
        { ...enabled, status: 'disabled' }
      ])
    ).toEqual([expect.objectContaining({ pluginKey: enabled.pluginKey, id: 'tasks' })])
  })

  it('bounds watchdog errors to installed panels and clears them on recovery', () => {
    const installed = {
      ...plugin('orca-samples.current'),
      panels: [
        {
          id: 'dashboard',
          title: 'Dashboard',
          tabKey: 'plugin:orca-samples.current/dashboard' as const
        }
      ]
    }
    usePluginPanelsStore.getState().setPlugins([installed])
    usePluginPanelsStore.getState().setPanelHealth('plugin:orca-samples.current/dashboard', 'error')
    expect(usePluginPanelsStore.getState().panelErrors).toEqual({
      'plugin:orca-samples.current/dashboard': true
    })

    usePluginPanelsStore
      .getState()
      .setPanelHealth('plugin:orca-samples.current/dashboard', 'healthy')
    expect(usePluginPanelsStore.getState().panelErrors).toEqual({})

    usePluginPanelsStore.getState().setPanelHealth('plugin:orca-samples.current/dashboard', 'error')
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
    resolveSecond([plugin('orca-samples.current')])
    await second
    resolveFirst([plugin('orca-samples.stale')])
    await first

    expect(usePluginPanelsStore.getState().plugins.map((entry) => entry.pluginKey)).toEqual([
      'orca-samples.current'
    ])
  })

  it('clears stale executable panels when the current list refresh fails', async () => {
    usePluginPanelsStore.setState({
      plugins: [plugin('orca-samples.stale')],
      fetchStatus: 'ready'
    })
    vi.stubGlobal('window', {
      api: { plugins: { list: vi.fn().mockRejectedValue(new Error('transport failed')) } }
    })

    await usePluginPanelsStore.getState().fetchPlugins()

    expect(usePluginPanelsStore.getState()).toMatchObject({
      plugins: [],
      fetchStatus: 'error'
    })
  })

  it('recovers automatically from a transient list failure with bounded backoff', async () => {
    vi.useFakeTimers()
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport starting'))
      .mockResolvedValueOnce([plugin('orca-samples.recovered')])
    vi.stubGlobal('window', { api: { plugins: { list } } })

    await usePluginPanelsStore.getState().fetchPlugins()
    expect(usePluginPanelsStore.getState().fetchStatus).toBe('error')

    await vi.advanceTimersByTimeAsync(250)

    expect(list).toHaveBeenCalledTimes(2)
    expect(usePluginPanelsStore.getState()).toMatchObject({
      fetchStatus: 'ready',
      plugins: [expect.objectContaining({ pluginKey: 'orca-samples.recovered' })]
    })
  })
})
