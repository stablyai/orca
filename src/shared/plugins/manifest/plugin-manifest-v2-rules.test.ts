import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pluginEngineFloor } from './plugin-engine-floor'
import { PLUGIN_ENUM_SINCE_KEY } from './plugin-engine-floor-keys'
import { PLUGIN_SCHEMA_NEWEST_SINCE, pluginHostVersion } from '../installation/plugin-host-version'
import { parseHostPluginManifest, parsePluginManifest } from './plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'
import { PLUGIN_RESERVED_CONTRIBUTION_POINTS } from '../contributions/plugin-contribution-points'

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
  it('defaults pluginApi and refuses it where no code calls the host API', () => {
    expect(parsePluginManifest(v2())).toMatchObject({ ok: true })
    expect(parsePluginManifest(v2({ pluginApi: 1 }))).toEqual({
      ok: false,
      error: 'pluginApi: data plugins never call the host API; remove pluginApi'
    })
    expect(
      parsePluginManifest(v2({ execution: 'trusted-worker', main: 'main.mjs', pluginApi: 1 }))
    ).toMatchObject({ ok: true })
  })

  it('refuses terminal:send below trusted-worker, since panels have no way to use it', () => {
    const panel = {
      execution: 'sandboxed-ui',
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'panel/index.html' }] },
      capabilities: [{ kind: 'notifications:show' }, { kind: 'terminal:send' }]
    }
    expect(parsePluginManifest(v2(panel))).toEqual({
      ok: false,
      error:
        "capabilities[1].kind: terminal:send needs the trusted-worker execution profile; sandboxed-ui plugins can't use it, so remove it or add a worker"
    })
    expect(
      parsePluginManifest(
        v2({ execution: 'trusted-worker', main: 'main.mjs', capabilities: panel.capabilities })
      )
    ).toMatchObject({ ok: true })
  })

  it('refuses host API majors this Orca does not implement', () => {
    const worker = { execution: 'trusted-worker', main: 'main.mjs' }
    expect(parsePluginManifest(v2({ ...worker, pluginApi: 2 }))).toEqual({
      ok: false,
      error: 'pluginApi: targets host API 2, but this Orca supports only 1; update Orca'
    })
    expect(parsePluginManifest(v2({ ...worker, pluginApi: 0 }))).toEqual({
      ok: false,
      error: 'pluginApi: must be 1'
    })
  })

  it('keeps contributes.agentHarnesses reserved and leaves agents unclaimed', () => {
    expect(
      parsePluginManifest(
        v2({ execution: 'declarative', contributes: { agentHarnesses: [{ path: 'a.json' }] } })
      )
    ).toEqual({
      ok: false,
      error:
        'contributes.agentHarnesses: is reserved for coding-agent harness definitions and must be empty for now'
    })
    expect(parsePluginManifest(v2({ contributes: { agents: [] } }))).toMatchObject({ ok: false })
  })

  it.each(Object.entries(PLUGIN_RESERVED_CONTRIBUTION_POINTS))(
    'reserves contributes.%s: empty is accepted, any item is refused',
    (key, purpose) => {
      expect(parsePluginManifest(v2({ contributes: { [key]: [] } }))).toMatchObject({ ok: true })
      expect(parsePluginManifest(v2({ contributes: { [key]: [{}] } }))).toEqual({
        ok: false,
        error: `contributes.${key}: is reserved for ${purpose} and must be empty for now`
      })
    }
  )

  it('requires engines.orca to cover every field the manifest uses', () => {
    expect(parsePluginManifest(v2({ engines: { orca: '>=1.4.160' } }))).toEqual({
      ok: false,
      error: `engines.orca: must be at least >=${PLUGIN_MANIFEST_V2_SINCE}, because manifestVersion needs Orca ${PLUGIN_MANIFEST_V2_SINCE}`
    })
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

  it('counts enum values and only fields that are present', () => {
    const schema = z.object({
      kind: z.enum(['old', 'new']).meta({
        'x-orca-since': '1.0.0',
        [PLUGIN_ENUM_SINCE_KEY]: { old: '1.0.0', new: '3.0.0' }
      }),
      extra: z.string().optional().meta({ 'x-orca-since': '5.0.0' }),
      list: z.array(z.object({ x: z.string().meta({ 'x-orca-since': '4.0.0' }) })).default([])
    })
    expect(pluginEngineFloor(schema, { kind: 'old', list: [] })).toEqual({
      version: '1.0.0',
      field: 'kind'
    })
    expect(pluginEngineFloor(schema, { kind: 'new', list: [] })?.version).toBe('3.0.0')
    expect(pluginEngineFloor(schema, { kind: 'old', list: [{ x: 'a' }] })).toEqual({
      version: '4.0.0',
      field: 'list[0].x'
    })
    expect(pluginEngineFloor(schema, { kind: 'old', list: [], extra: 'y' })?.version).toBe('5.0.0')
  })

  it('gates development builds as the newest release their schemas describe', () => {
    expect(pluginHostVersion('1.4.214')).toBe(PLUGIN_SCHEMA_NEWEST_SINCE)
    expect(pluginHostVersion('1.4.214-local.1.abc')).toBe(PLUGIN_SCHEMA_NEWEST_SINCE)
    expect(pluginHostVersion('99.0.0')).toBe('99.0.0')
  })
})
