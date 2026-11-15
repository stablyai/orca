import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'

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
})
