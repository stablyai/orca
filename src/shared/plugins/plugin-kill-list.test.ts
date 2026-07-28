import { describe, expect, it } from 'vitest'
import {
  PLUGIN_KILL_LIST_ENTRY_LIMIT,
  findKilledPlugin,
  killedPluginKeys,
  pluginKillListSchema
} from './plugin-kill-list'

function entry(pluginKey = 'community.unsafe'): Record<string, unknown> {
  return {
    pluginKey,
    reason: 'Known malicious release',
    advisoryUrl: 'https://orca.example/security/unsafe'
  }
}

describe('pluginKillListSchema', () => {
  it('parses a strict versioned revocation document', () => {
    const parsed = pluginKillListSchema.parse({
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [entry()]
    })

    expect(findKilledPlugin(parsed, 'community.unsafe')).toEqual(entry())
    expect(killedPluginKeys(parsed)).toEqual(new Set(['community.unsafe']))
  })

  it.each([
    {
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [],
      unexpected: true
    },
    {
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [{ ...entry(), unexpected: true }]
    },
    {
      version: 1,
      generatedAt: 'not-a-date',
      plugins: []
    },
    {
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [{ ...entry(), pluginKey: 'unsafe' }]
    },
    {
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [{ ...entry(), advisoryUrl: 'http://orca.example/advisory' }]
    }
  ])('rejects malformed or untrusted fields', (killList) => {
    expect(pluginKillListSchema.safeParse(killList).success).toBe(false)
  })

  it('rejects duplicate killed plugin identities', () => {
    const parsed = pluginKillListSchema.safeParse({
      version: 1,
      generatedAt: '2026-07-12T20:00:00Z',
      plugins: [entry(), entry()]
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'duplicate killed plugin: community.unsafe' })
        ])
      )
    }
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
