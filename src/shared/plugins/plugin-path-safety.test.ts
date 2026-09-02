import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import { isSafePluginRelativePath } from './plugin-path-safety'

describe('plugin path portability', () => {
  it.each([
    'CON',
    'assets/aux.txt',
    'dist/panel.html.',
    'dist/panel.html ',
    'dist/panel.html:payload',
    'dist\\LPT1.js',
    '../worker.js',
    'dist//panel.html'
  ])('rejects %s on every host platform', (path) => {
    expect(isSafePluginRelativePath(path)).toBe(false)
  })

  it.each(['dist/panel.html', 'assets/.icon.svg', 'nested\\worker.js'])('accepts %s', (path) => {
    expect(isSafePluginRelativePath(path)).toBe(true)
  })

  it('applies portable path validation to every declared artifact kind', () => {
    const base = {
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
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
