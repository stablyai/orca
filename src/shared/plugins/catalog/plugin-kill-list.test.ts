import { describe, expect, it } from 'vitest'
import { pluginKillListSchema } from './plugin-kill-list'

function entry(pluginKey = 'community.unsafe'): Record<string, unknown> {
  return {
    pluginKey,
    reason: 'Known malicious release',
    advisoryUrl: 'https://orca.example/security/unsafe'
  }
}

describe('pluginKillListSchema', () => {
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
})
