import { describe, expect, it } from 'vitest'
import { installedPluginPresentation, sortByAttention } from './plugin-status-presentation'
import type { PluginHostListEntry } from '../../../../../preload/api-types'

function host(pluginKey: string, extra: Partial<PluginHostListEntry> = {}): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name: pluginKey,
    version: '1.0.0',
    publisher: 'acme',
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    ...extra
  }
}

const idle = { updatedTo: null, needsReview: false }

describe('plugin status presentation', () => {
  it('offers Reinstall for a plugin that cannot load, and View error without one', () => {
    const broken = host('a', { status: 'invalid' })
    expect(installedPluginPresentation(broken, null, false, idle, '1.0.0').primary).toBe(
      'reinstall'
    )
    expect(installedPluginPresentation(broken, null, false, idle).primary).toBe('error')
  })

  it('puts plugins that need the user first, then updates, keeping order within each', () => {
    const rows = [
      { installed: host('a'), update: false },
      { installed: host('b'), update: true },
      { installed: host('c', { status: 'errored' }), update: false },
      { installed: host('d', { status: 'pending' }), update: false },
      { installed: host('e'), update: false }
    ]
    expect(
      sortByAttention(rows, (row) => row.update).map((row) => row.installed.pluginKey)
    ).toEqual(['c', 'd', 'b', 'a', 'e'])
  })
})
