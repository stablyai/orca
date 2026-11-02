import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pluginEngineFloor } from './plugin-engine-floor'
import { PLUGIN_ENUM_SINCE_KEY } from './plugin-engine-floor-keys'
import { parseHostPluginManifest, parsePluginManifest } from './plugin-manifest'
import {
  PLUGIN_DERIVED_PUBLISHER_SINCE,
  PLUGIN_MANIFEST_V2_SINCE
} from './plugin-schema-field-docs'

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
  it('lets publisher be left out only where older Orca will say it needs a newer one', () => {
    const { publisher: _publisher, ...withoutPublisher } = v2()
    expect(parsePluginManifest(withoutPublisher)).toEqual({
      ok: false,
      error: `engines.orca: must be at least >=${PLUGIN_DERIVED_PUBLISHER_SINCE} when publisher is left out, because older Orca requires publisher`
    })
    expect(
      parsePluginManifest({
        ...withoutPublisher,
        engines: { orca: `>=${PLUGIN_DERIVED_PUBLISHER_SINCE}` }
      })
    ).toMatchObject({ ok: true })
    // Why the host still reads it: the floor only exists for older hosts.
    expect(parseHostPluginManifest(withoutPublisher)).toMatchObject({ ok: true })
  })

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
})
