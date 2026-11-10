import { describe, expect, it } from 'vitest'
import {
  PLUGIN_KILL_LIST_ENTRY_LIMIT,
  findKilledPlugin,
  isPluginKillListTooFarInFuture,
  pluginKillListSchema,
  type PluginKillList
} from './plugin-kill-list'

function entry(pluginKey = 'community.unsafe'): Record<string, unknown> {
  return {
    pluginKey,
    reason: 'Known malicious release',
    advisoryUrl: 'https://orca.example/security/unsafe'
  }
}

describe('pluginKillListSchema', () => {
  it('ignores fields a later list adds so old clients keep revoking', () => {
    const parsed = pluginKillListSchema.parse({
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [{ ...entry(), contentHash: 'f'.repeat(64) }],
      revoked: []
    })

    expect(findKilledPlugin(parsed, 'community.unsafe')).toEqual(entry())
  })

  it('drops only the entries it cannot read, and keeps one entry per plugin', () => {
    const parsed = pluginKillListSchema.parse({
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [
        { ...entry(), pluginKey: 'unsafe' },
        { ...entry('community.other'), advisoryUrl: 'http://orca.example/advisory' },
        { publisher: 'community', reason: 'keyed by a field this client predates' },
        entry(),
        { ...entry(), reason: 'duplicate' }
      ]
    })
    expect(parsed.plugins).toEqual([entry()])
  })

  it('caps the revocation document size by entry count', () => {
    const plugins = Array.from({ length: PLUGIN_KILL_LIST_ENTRY_LIMIT + 1 }, (_, index) =>
      entry(`publisher.plugin-${index}`)
    )
    expect(
      pluginKillListSchema.safeParse({
        version: 1,
        generatedAt: '2026-07-12T20:00:00Z',
        plugins
      }).success
    ).toBe(false)
  })
})

describe('isPluginKillListTooFarInFuture', () => {
  const list = (generatedAt: string): PluginKillList =>
    pluginKillListSchema.parse({ version: 1, generatedAt, plugins: [entry()] })

  it('flags a snapshot that would freeze out every later revocation', () => {
    expect(isPluginKillListTooFarInFuture(list('9999-12-31T23:59:59Z'))).toBe(true)
  })
})
