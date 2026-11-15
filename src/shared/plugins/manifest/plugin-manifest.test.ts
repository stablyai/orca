import { describe, expect, it } from 'vitest'
import {
  parseHostPluginManifest,
  parsePluginManifest,
  pluginManifestSchema
} from './plugin-manifest'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [], commands: [], events: [] },
    capabilities: [],
    ...overrides
  }
}

describe('pluginManifestSchema boundaries', () => {
  it('reads format 1 names as their renamed successors', () => {
    const result = parsePluginManifest(
      manifest({
        main: 'main.mjs',
        contributes: {
          commands: [{ id: 'run', title: 'Run', context: 'worktree' }],
          keybindings: [{ command: 'run', key: 'Mod+Shift+R', when: 'worktree' }],
          events: [{ on: 'worktree.created' }],
          themes: [{ id: 'dusk', label: 'Dusk', path: 'dusk.json' }],
          syntaxes: [{ id: 'g', label: 'G', scopeName: 'source.g', path: 'g.json' }],
          customEditors: [{ id: 'd', title: 'D', fileTypes: ['draw'], entry: 'd.html' }]
        },
        capabilities: [{ kind: 'storage' }, { kind: 'secrets' }, { kind: 'events:subscribe' }]
      })
    )

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        contributes: {
          commands: [{ when: 'workspace' }],
          keybindings: [{ when: 'workspace' }],
          events: [{ on: 'workspace.created' }],
          themes: [{ title: 'Dusk' }],
          syntaxes: [{ title: 'G' }],
          customEditors: [{ extensions: ['.draw'] }]
        },
        capabilities: [
          { kind: 'storage:own' },
          { kind: 'secrets:own' },
          { kind: 'workspace:read' },
          { kind: 'agent:read' }
        ]
      }
    })
  })

  it('requires the panel icon floor for emoji and file icons', () => {
    const format2 = (orcVersion: string, icon: string) => ({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'icons',
      name: 'Icons',
      version: '1.0.0',
      engines: { orca: `>=${orcVersion}` },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'one', title: 'One', icon, entry: 'panel.html' }]
      }
    })

    expect(pluginManifestSchema.safeParse(format2('1.4.259', '🧩')).success).toBe(false)
    expect(pluginManifestSchema.safeParse(format2('1.4.260', '🧩')).success).toBe(true)
    expect(pluginManifestSchema.safeParse(format2('1.4.259', 'icons/panel.svg')).success).toBe(
      false
    )
    expect(pluginManifestSchema.safeParse(format2('1.4.260', 'icons/panel.png')).success).toBe(true)
    expect(parseHostPluginManifest(format2('1.4.259', '🧩')).ok).toBe(true)
  })

  it('keeps format 1 panel icons in the older closed-name vocabulary', () => {
    const result = parsePluginManifest(
      manifest({
        contributes: { panels: [{ id: 'one', title: 'One', icon: '🧩', entry: 'panel.html' }] }
      })
    )

    expect(result).toMatchObject({
      ok: true,
      manifest: { contributes: { panels: [{ id: 'one', title: 'One' }] } }
    })
    if (result.ok) {
      expect(result.manifest.contributes.panels[0]).not.toHaveProperty('icon')
    }
  })
})
