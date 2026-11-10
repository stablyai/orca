import { describe, expect, it } from 'vitest'
import { AiVaultSearchStatusSchema } from './ai-vault-search-contract'
import { searchHit } from './ai-vault-search-test-fixture'
import { redactForTransport, redactStatusForTransport } from './ai-vault-search-transport'
import { unavailableSessionSearchStatus } from './ai-vault-search-client'

describe('session search public contract', () => {
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
})
