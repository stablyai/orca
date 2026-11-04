import { describe, expect, it } from 'vitest'
import { AiVaultSearchResponseSchema, AiVaultSearchStatusSchema } from './ai-vault-search-contract'
import { searchHit, searchResults } from './ai-vault-search-test-fixture'
import { redactForTransport, redactStatusForTransport } from './ai-vault-search-transport'
import { unavailableSessionSearchStatus } from './ai-vault-search-client'

describe('session search public contract', () => {
  it('never accepts resume commands for an unverified or missing source', () => {
    for (const presence of ['unverifiable', 'missing'] as const) {
      const response = searchResults()
      response.hits[0].source.presence = presence
      expect(AiVaultSearchResponseSchema.safeParse(response).success).toBe(false)
    }
  })
  it.each(['ipc', 'runtime', 'relay'] as const)(
    'enforces the %s exposure policy without mutating the hit',
    (transport) => {
      const hit = searchHit()
      const original = structuredClone(hit)
      const result = redactForTransport(hit, transport)
      expect(hit).toEqual(original)
      expect(result.cwd).toBe('/host/folder')
      if (transport === 'relay') {
        expect(result.source).toEqual({ presence: 'present' })
        expect(result).not.toHaveProperty('resumeCommand')
      } else {
        expect(result).toEqual(hit)
      }
      for (const presence of ['unverifiable', 'missing'] as const) {
        expect(
          redactForTransport({ ...hit, source: { ...hit.source, presence } }, transport)
        ).not.toHaveProperty('resumeCommand')
      }
    }
  )
  it.each(['ipc', 'runtime', 'relay'] as const)(
    'withholds degraded-root paths from %s status without mutating it',
    (transport) => {
      const status = {
        ...unavailableSessionSearchStatus(),
        degradedRoots: [{ root: '/host/projects', reason: 'could not be listed' }]
      }
      const original = structuredClone(status)
      const result = redactStatusForTransport(status, transport)
      expect(status).toEqual(original)
      expect(AiVaultSearchStatusSchema.parse(result)).toEqual(result)
      expect(result.degradedRoots).toEqual([
        transport === 'relay'
          ? { reason: 'Source root could not be verified.' }
          : { root: '/host/projects', reason: 'could not be listed' }
      ])
    }
  )
  it.each([
    '/host/private/path could not be listed.',
    "EACCES: permission denied, scandir '/host/private/path'",
    "EACCES: permission denied, scandir 'C:\\Users\\private\\sessions'"
  ])('withholds paths embedded in relay diagnostics: %s', (reason) => {
    const status = {
      ...unavailableSessionSearchStatus(),
      degradedRoots: [{ root: '/host/private/path', reason }]
    }
    const result = redactStatusForTransport(status, 'relay')
    expect(result.degradedRoots).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('/host/private/path')
    expect(JSON.stringify(result)).not.toContain('private')
    expect(redactStatusForTransport(status, 'runtime')).toEqual(status)
  })
})
