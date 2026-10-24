import { describe, expect, it } from 'vitest'
import { pluginManifestSchema, type PluginManifest } from '../manifest/plugin-manifest'
import type { PluginCapability } from '../plugin-capabilities'
import { pluginUpdateAccessGrowth } from './plugin-update-access-growth'

function declarative(contributes: Record<string, unknown>): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    capabilities: [],
    contributes
  })
}

const commands = [
  { id: 'demo.open', title: 'Open', action: 'sidebar.left.toggle' },
  { id: 'demo.close', title: 'Close', action: 'sidebar.right.toggle' }
]

describe('pluginUpdateAccessGrowth', () => {
  it('counts a command whose action changed under the same id', () => {
    const before = declarative({ commands: commands.slice(0, 1) })
    const after = declarative({
      commands: [{ id: 'demo.open', title: 'Open', action: 'sidebar.right.toggle' }]
    })
    expect(pluginUpdateAccessGrowth(before, after).contributions).toEqual(['commands'])
  })

  it('counts a shortcut whose chord or target command changed', () => {
    const before = declarative({
      commands,
      keybindings: [{ command: 'demo.open', key: 'CmdOrCtrl+Shift+9' }]
    })
    for (const keybinding of [
      { command: 'demo.open', key: 'CmdOrCtrl+Shift+8' },
      { command: 'demo.close', key: 'CmdOrCtrl+Shift+9' }
    ]) {
      const after = declarative({ commands, keybindings: [keybinding] })
      expect(pluginUpdateAccessGrowth(before, after).contributions).toEqual(['keybindings'])
    }
  })

  it('counts a same-kind capability whose declaration widened', () => {
    const before = declarative({})
    const after = declarative({})
    before.capabilities = [{ kind: 'notifications:show' }]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models a scoped field a later capability format adds.
    after.capabilities = [{ kind: 'notifications:show', hosts: ['*'] } as PluginCapability]
    expect(pluginUpdateAccessGrowth(before, after).capabilities).toEqual(['notifications:show'])
    expect(pluginUpdateAccessGrowth(after, after).capabilities).toEqual([])
  })
})
