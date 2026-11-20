import { expect, it } from 'vitest'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { pluginUpdateAdditions } from './plugin-update-additions'

const manifest = (handlers: string[]) =>
  pluginManifestSchema.parse({
    manifestVersion: 2,
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    execution: 'trusted-worker',
    main: 'worker.js',
    engines: { orca: '>=1.4.267' },
    capabilities: handlers.map((handler) => ({ kind: 'cli:request', handler }))
  })

it('names only the CLI handlers an update adds and keeps a line for a grant it cannot name', () => {
  const preview: PluginMarketplaceHostInstallPreview = {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Plugins',
    marketplaceOwner: 'acme',
    marketplaceCommit: 'c',
    pluginKey: 'acme.notes',
    source: { kind: 'git', url: 'https://github.com/acme/notes.git', ref: 'v1.0.0' },
    resolvedCommit: 'd'.repeat(40),
    contentHash: 'e'.repeat(64),
    consentFingerprint: 'next',
    manifest: manifest(['notes.list', 'notes.delete']),
    official: false,
    bundled: false,
    accessGrowth: {
      capabilities: ['cli:request', 'history:read'],
      execution: null,
      contributions: []
    }
  }
  const { lines } = pluginUpdateAdditions(
    preview,
    manifest(['notes.list']),
    (_key, fallback) => fallback
  )
  expect(lines).toEqual([expect.stringMatching(/: notes\.delete$/), 'history:read'])
})
