import { describe, expect, it } from 'vitest'

import { parseHostPluginManifest, parsePluginManifest } from './plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'

function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    ...overrides
  }
}

describe('manifest format 2 rules', () => {
  it('validates panel placement and gates even an explicit right-sidebar placement', () => {
    const panel = { id: 'p', title: 'P', entry: 'panel/index.html' }
    const withPanels = (placement?: string, version = '1.4.245') =>
      v2({
        execution: 'sandboxed-ui',
        engines: { orca: `>=${version}` },
        contributes: { panels: [{ ...panel, ...(placement === undefined ? {} : { placement }) }] }
      })

    expect(parsePluginManifest(withPanels())).toMatchObject({ ok: true })
    expect(parsePluginManifest(withPanels('right-sidebar'))).toEqual({
      ok: false,
      error: `engines.orca: must be at least >=1.4.246, because contributes.panels[0].placement needs Orca 1.4.246`
    })
    expect(parsePluginManifest(withPanels('left-navigation'))).toMatchObject({ ok: false })
    expect(parsePluginManifest(withPanels('left-navigation', '1.4.246'))).toMatchObject({
      ok: true,
      manifest: { contributes: { panels: [{ ...panel, placement: 'left-navigation' }] } }
    })
    expect(parsePluginManifest(withPanels('somewhere-else', '1.4.246'))).toMatchObject({
      ok: false
    })
    expect(parseHostPluginManifest(withPanels('left-navigation'))).toMatchObject({ ok: true })
  })
  it('skips only the engines floor when reading a manifest at runtime', () => {
    const underDeclared = v2({ engines: { orca: '>=1.4.160' } })
    expect(parseHostPluginManifest(underDeclared)).toMatchObject({ ok: true })
    expect(parsePluginManifest(underDeclared)).toMatchObject({ ok: false })
    // Every other rule still applies.
    expect(parseHostPluginManifest(v2({ engines: { orca: '>=1.4.160' }, pluginApi: 1 }))).toEqual({
      ok: false,
      error: 'pluginApi: data plugins never call the host API; remove pluginApi'
    })
  })
})
