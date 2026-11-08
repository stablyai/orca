// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { collectActivePluginCommands, usePluginPanelsStore } from './plugin-contribution-catalog'

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

describe('plugin names on contributions', () => {
  it("adds the publisher to a non-official plugin sharing an official plugin's name", () => {
    const command = {
      id: 'apply',
      title: 'Apply',
      context: 'global' as const,
      handler: { type: 'worker' as const },
      keybindings: []
    }
    const official = {
      ...plugin('stablyai.orca-catppuccin-theme'),
      name: 'Catppuccin for Orca',
      publisher: 'stablyai',
      official: true,
      commands: [command]
    }
    const community = {
      ...plugin('vale-c.catppuccin'),
      name: 'Catppuccin for Orca',
      publisher: 'vale-c',
      commands: [command]
    }
    expect(collectActivePluginCommands([official, community]).map((c) => c.pluginName)).toEqual([
      'Catppuccin for Orca',
      'Catppuccin for Orca (vale-c)'
    ])
  })
})
