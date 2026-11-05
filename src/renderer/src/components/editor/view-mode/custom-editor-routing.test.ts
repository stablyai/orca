import { describe, expect, it } from 'vitest'

import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import {
  collectActivePluginCustomEditors,
  customEditorsForFile
} from '@/store/plugin-custom-editors'

function plugin(
  overrides: Partial<PluginHostListEntry> & Pick<PluginHostListEntry, 'pluginKey'>
): PluginHostListEntry {
  return {
    consentFingerprint: null,
    name: overrides.pluginKey,
    version: '1.0.0',
    publisher: 'stablyai',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: true,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    customEditors: [
      { id: 'draw', title: 'Draw', extensions: ['.excalidraw'], filenames: [], priority: 'default' }
    ],
    ...overrides
  }
}

describe('custom editor routing', () => {
  it('breaks a tie between two default editors by plugin key, not list order', () => {
    const draw = (pluginKey: string) =>
      plugin({
        pluginKey,
        customEditors: [
          {
            id: 'd',
            title: pluginKey,
            extensions: ['.excalidraw'],
            filenames: [],
            priority: 'default'
          }
        ]
      })
    const editors = customEditorsForFile(
      '/repo/diagram.excalidraw',
      collectActivePluginCustomEditors([draw('zeta.draw'), draw('alpha.draw')])
    )
    expect(editors[0]?.pluginKey).toBe('alpha.draw')
  })
})
