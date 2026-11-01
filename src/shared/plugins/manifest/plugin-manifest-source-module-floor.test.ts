import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import { PLUGIN_SOURCE_MODULES_SINCE } from './plugin-schema-field-docs'

function manifest(entry: string, engine: string) {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'todos',
    // Kept so only the source-module floor applies, not the omitted-publisher one.
    publisher: 'acme',
    name: 'Todos',
    version: '1.0.0',
    engines: { orca: engine },
    pluginApi: 1,
    // An html panel: `ui: "components"` would raise the floor by itself.
    contributes: { panels: [{ id: 'todos', title: 'Todos', entry }] }
  }
}

describe('source module entry engine floor', () => {
  it('needs the release that transpiles a .ts entry', () => {
    const tooLow = parsePluginManifest(manifest('app/page.ts', '>=1.4.245'))
    expect(tooLow.ok).toBe(false)
    expect(tooLow.ok ? '' : tooLow.error).toContain(
      `>=${PLUGIN_SOURCE_MODULES_SINCE} when a panel or editor entry`
    )
    expect(
      parsePluginManifest(manifest('app/page.ts', `>=${PLUGIN_SOURCE_MODULES_SINCE}`)).ok
    ).toBe(true)
  })

  it('leaves HTML entries at their own floor', () => {
    expect(parsePluginManifest(manifest('panel.html', '>=1.4.245')).ok).toBe(true)
  })
})
