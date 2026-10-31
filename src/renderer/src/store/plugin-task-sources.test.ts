import { describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../preload/api-types'
import { collectActivePluginTaskSources } from './plugin-task-sources'

function plugin(
  pluginKey: string,
  status: PluginHostListEntry['status'],
  taskSources?: PluginHostListEntry['taskSources']
): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: 'sha256-test',
    name: `${pluginKey} name`,
    version: '1.0.0',
    publisher: 'orca-samples',
    status,
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: true,
    restarts: 0,
    ...(taskSources ? { taskSources } : {})
  }
}

describe('collectActivePluginTaskSources', () => {
  it('lists sources of enabled and errored plugins only', () => {
    const sources = collectActivePluginTaskSources([
      plugin('orca-samples.on', 'idle', [{ id: 'plans', title: 'Plans', icon: 'map' }]),
      plugin('orca-samples.broken', 'errored', [{ id: 'bugs', title: 'Bugs' }]),
      plugin('orca-samples.off', 'disabled', [{ id: 'off', title: 'Off' }]),
      plugin('orca-samples.pending', 'pending', [{ id: 'later', title: 'Later' }]),
      plugin('orca-samples.old-host', 'running')
    ])

    expect(sources).toEqual([
      {
        pluginKey: 'orca-samples.on',
        sourceId: 'plans',
        key: 'orca-samples.on/plans',
        pluginName: 'orca-samples.on name',
        title: 'Plans',
        icon: 'map'
      },
      {
        pluginKey: 'orca-samples.broken',
        sourceId: 'bugs',
        key: 'orca-samples.broken/bugs',
        pluginName: 'orca-samples.broken name',
        title: 'Bugs'
      }
    ])
  })
})
