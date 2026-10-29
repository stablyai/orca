import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import {
  pluginPageExecutionProfile,
  pluginPointsFromManifest,
  pluginTrust
} from './plugin-access-profile'
import { pluginTrustWarnings } from './plugin-consent-copy'

const commandManifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'shortcuts',
  publisher: 'acme',
  name: 'Shortcuts',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: {
    commands: [{ id: 'toggle', title: 'Toggle', action: 'sidebar.left.toggle' }]
  }
})

describe('pluginPageExecutionProfile', () => {
  it('uses the release profile for a listed plugin, not the absence of a worker', () => {
    expect(
      pluginPageExecutionProfile({
        installed: null,
        installedManifest: undefined,
        listing: {
          release: {
            version: '1.0.0',
            commit: 'a'.repeat(40),
            contentHash: 'b'.repeat(64),
            execution: 'declarative',
            minimumOrca: '1.0.0',
            types: ['instructions']
          }
        },
        previewManifest: null
      })
    ).toBe('declarative')
  })

  it('derives from the fetched manifest when the catalog has no release record', () => {
    expect(
      pluginPageExecutionProfile({
        installed: null,
        installedManifest: undefined,
        listing: { release: undefined },
        previewManifest: commandManifest
      })
    ).toBe('declarative')
  })

  it('is unknown until something verified says otherwise', () => {
    expect(
      pluginPageExecutionProfile({
        installed: null,
        installedManifest: undefined,
        listing: { release: undefined },
        previewManifest: null
      })
    ).toBeNull()
    expect(
      pluginPageExecutionProfile({
        installed: {},
        installedManifest: undefined,
        listing: null,
        previewManifest: null
      })
    ).toBeNull()
  })

  it('reads the installed manifest when an older host omits the profile', () => {
    expect(
      pluginPageExecutionProfile({
        installed: {},
        installedManifest: commandManifest,
        listing: null,
        previewManifest: null
      })
    ).toBe('declarative')
  })
})

describe('pluginTrust', () => {
  it('warns about commands a panel profile carries, and never calls it bounded', () => {
    const trust = pluginTrust({
      execution: 'sandboxed-ui',
      points: pluginPointsFromManifest(commandManifest)
    })
    expect(trust).toEqual({ worker: false, declarative: true, panel: true })
    expect(pluginTrustWarnings(trust)).toEqual(['Its commands can act for you or your agents'])
  })

  it('adds no warning for a panel known to carry no instructions', () => {
    const trust = pluginTrust({ execution: 'sandboxed-ui', points: new Set(['panels']) })
    expect(pluginTrustWarnings(trust)).toEqual([])
  })

  it('over-warns when the profile or contributions are unknown', () => {
    expect(pluginTrust({ execution: 'sandboxed-ui', points: null }).declarative).toBe(true)
    expect(pluginTrust({ execution: null, points: null })).toEqual({
      worker: false,
      declarative: true,
      panel: false
    })
    expect(pluginTrust({ execution: null, points: null, hasWorker: true }).worker).toBe(true)
  })

  it('claims nothing runs only for content-only plugins', () => {
    expect(pluginTrust({ execution: 'data', points: null })).toEqual({
      worker: false,
      declarative: false,
      panel: false
    })
  })
})
