// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useAppStore } from '.'
import { usePluginPanelsStore } from './plugin-panels'
import { usePluginTaskSourceContributions } from './plugin-task-source-contributions'
import type { PluginHostListEntry } from '../../../preload/api-types'

function pluginEntry(overrides: Partial<PluginHostListEntry> & { pluginKey: string }) {
  return {
    consentFingerprint: 'sha256-test',
    name: overrides.pluginKey,
    version: '1.0.0',
    publisher: 'orca-samples',
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    taskSources: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    ...overrides
  } satisfies PluginHostListEntry
}

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('plugin task source contributions', () => {
  it('mirrors the plugin list contributions into the app store', () => {
    renderHook(() => usePluginTaskSourceContributions())

    act(() => {
      usePluginPanelsStore.getState().setPlugins([
        pluginEntry({
          pluginKey: 'orca-samples.issues',
          taskSources: [{ id: 'boards', title: 'Boards' }]
        })
      ])
    })

    expect(useAppStore.getState().pluginTaskSources).toEqual([
      { pluginKey: 'orca-samples.issues', sourceId: 'boards', title: 'Boards' }
    ])
  })

  it('drops contributions when the contributing plugin leaves the list', () => {
    renderHook(() => usePluginTaskSourceContributions())

    act(() => {
      usePluginPanelsStore.getState().setPlugins([
        pluginEntry({
          pluginKey: 'orca-samples.issues',
          taskSources: [{ id: 'boards', title: 'Boards' }]
        })
      ])
    })
    act(() => {
      usePluginPanelsStore.getState().setPlugins([])
    })

    expect(useAppStore.getState().pluginTaskSources).toEqual([])
  })

  it('clears a selection whose plugin left the list', () => {
    renderHook(() => usePluginTaskSourceContributions())

    act(() => {
      usePluginPanelsStore.getState().setPlugins([
        pluginEntry({
          pluginKey: 'orca-samples.issues',
          taskSources: [{ id: 'boards', title: 'Boards' }]
        })
      ])
    })
    act(() => {
      useAppStore
        .getState()
        .selectPluginTaskSource({ pluginKey: 'orca-samples.issues', sourceId: 'boards' })
      usePluginPanelsStore.getState().setPlugins([])
    })

    expect(useAppStore.getState().selectedPluginTaskSource).toBeNull()
  })
})
