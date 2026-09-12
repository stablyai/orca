import { describe, expect, it } from 'vitest'
import {
  AiVaultSearchRequestSchema,
  AiVaultSearchResponseSchema,
  AiVaultSearchStatusSchema
} from './ai-vault-search-contract'
import { searchHit, searchResults } from './ai-vault-search-test-fixture'
import { redactForTransport } from './ai-vault-search-transport'
import { unavailableSessionSearchStatus } from './ai-vault-search-client'

describe('session search public contract', () => {
  it('drops legacy fields without letting them override scope or freshness', () => {
    expect(
      AiVaultSearchRequestSchema.parse({ query: 'needle', tier: 'conversation', refresh: true })
    ).toEqual({ query: 'needle', limit: 20 })
  })
  it.each([
    [0, 1],
    [-4, 1],
    [200, 100],
    [2.5, 20],
    [undefined, 20]
  ])('clamps %s to %s', (limit, expected) => {
    expect(AiVaultSearchRequestSchema.parse({ query: 'needle', limit }).limit).toBe(expected)
  })
  it('allows the engine to report long-query truncation', () => {
    const query = 'needle '.repeat(100)
    expect(AiVaultSearchRequestSchema.parse({ query }).query).toBe(query)
  })
  it('validates every response variant and separate status', () => {
    for (const response of [
      searchResults(),
      { kind: 'malformed-cursor' },
      { kind: 'stale-cursor', generation: 2, expectedGeneration: 1 },
      ...['disabled', 'not-ready', 'no-service'].map((reason) => ({ kind: 'unavailable', reason }))
    ]) {
      expect(AiVaultSearchResponseSchema.parse(response)).toEqual(response)
    }
    expect(AiVaultSearchStatusSchema.parse(unavailableSessionSearchStatus())).toEqual(
      unavailableSessionSearchStatus()
    )
    expect(AiVaultSearchResponseSchema.safeParse({ kind: 'results', hits: [] }).success).toBe(false)
  })
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
})
