import { expect, it } from 'vitest'
import { pluginManifestSchema } from '../manifest/plugin-manifest'
import { pluginUpdateAccessGrowth } from '../approval/plugin-update-access-growth'

it('requires a new approval when another CLI handler is added to an existing grant kind', () => {
  const raw = {
    manifestVersion: 2,
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    execution: 'trusted-worker',
    main: 'worker.js',
    engines: { orca: '>=1.4.267' },
    capabilities: [{ kind: 'cli:request', handler: 'notes.list' }]
  }
  expect(
    pluginManifestSchema.safeParse({ ...raw, capabilities: [{ kind: 'cli:request' }] }).success
  ).toBe(false)
  const installed = pluginManifestSchema.parse(raw)
  const next = pluginManifestSchema.parse({
    ...raw,
    capabilities: [...raw.capabilities, { kind: 'cli:request', handler: 'notes.delete' }]
  })
  expect(pluginUpdateAccessGrowth(installed, next).capabilities).toEqual(['cli:request'])
  expect(pluginUpdateAccessGrowth(next, installed).capabilities).toEqual([])
})
