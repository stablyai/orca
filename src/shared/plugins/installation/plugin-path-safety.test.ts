import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'

describe('plugin path portability', () => {
  it('applies portable path validation to every declared artifact kind', () => {
    const base = {
      manifestVersion: 1,
      id: 'demo',
      publisher: 'samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { panels: [], commands: [], events: [] },
      capabilities: []
    }

    expect(parsePluginManifest({ ...base, icon: 'assets/NUL.svg' }).ok).toBe(false)
    expect(parsePluginManifest({ ...base, main: 'dist/worker.js.' }).ok).toBe(false)
    expect(
      parsePluginManifest({
        ...base,
        contributes: {
          ...base.contributes,
          panels: [{ id: 'panel', title: 'Panel', entry: 'dist/panel.html:ads' }]
        }
      }).ok
    ).toBe(false)
  })
})
