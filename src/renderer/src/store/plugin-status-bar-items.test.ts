import { describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../preload/api-types'
import { collectPluginStatusBarItems } from './plugin-status-bar-items'

function plugin(overrides: Partial<PluginHostListEntry> = {}): PluginHostListEntry {
  return {
    pluginKey: 'acme.guard',
    consentFingerprint: null,
    name: 'Guard',
    version: '1.0.0',
    publisher: 'acme',
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [
      {
        id: 'guard.log',
        title: 'Show log',
        context: 'global',
        handler: { type: 'worker' },
        keybindings: []
      }
    ],
    statusBarItems: [
      { id: 'blocked', text: '0 blocked', icon: 'flag', command: 'guard.log' },
      { id: 'quiet', icon: 'bell' }
    ],
    hasWorker: true,
    restarts: 0,
    ...overrides
  }
}

describe('collectPluginStatusBarItems', () => {
  it("applies a worker's changes over the manifest and resolves the command", () => {
    const items = collectPluginStatusBarItems([plugin()], {
      'acme.guard': { blocked: { text: '2 blocked', tone: 'danger' } }
    })
    expect(items).toEqual([
      expect.objectContaining({
        key: 'acme.guard/blocked',
        text: '2 blocked',
        icon: 'flag',
        tone: 'danger',
        tooltip: 'Guard',
        command: expect.objectContaining({ id: 'guard.log', pluginKey: 'acme.guard' })
      }),
      expect.objectContaining({ key: 'acme.guard/quiet', tone: 'neutral', command: null })
    ])
  })

  it('hides items a worker hid, empty items and disabled plugins', () => {
    expect(
      collectPluginStatusBarItems([plugin()], {
        'acme.guard': { blocked: { visible: false } }
      }).map((item) => item.key)
    ).toEqual(['acme.guard/quiet'])
    expect(
      collectPluginStatusBarItems([plugin({ statusBarItems: [{ id: 'empty' }] })], {})
    ).toEqual([])
    expect(collectPluginStatusBarItems([plugin({ status: 'disabled' })], {})).toEqual([])
    // Older hosts list no status bar items.
    expect(collectPluginStatusBarItems([plugin({ statusBarItems: undefined })], {})).toEqual([])
  })
})
