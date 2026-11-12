import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'

const panel = { id: 'board', title: 'Board' }

function manifest(engine: string, panelFields: Record<string, unknown>) {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'board',
    publisher: 'acme',
    name: 'Board',
    version: '1.0.0',
    engines: { orca: engine },
    pluginApi: 1,
    contributes: { panels: [{ ...panel, entry: 'panel.js', ...panelFields }] }
  }
}

describe('panel ui', () => {
  it('makes authors declare the release that reads ui and the newer icons', () => {
    expect(parsePluginManifest(manifest('>=1.4.245', { ui: 'components' })).ok).toBe(false)
    expect(parsePluginManifest(manifest('>=1.4.245', { icon: 'add' })).ok).toBe(false)
    expect(parsePluginManifest(manifest('>=1.4.245', { icon: 'rocket' })).ok).toBe(true)
    expect(parsePluginManifest(manifest('>=1.4.246', { ui: 'components', icon: 'add' })).ok).toBe(
      true
    )
  })
})
