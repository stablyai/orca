import {
  AiVaultSearchRequestSchema,
  AiVaultSearchResponseSchema,
  AiVaultSearchStatusSchema
} from './ai-vault-search-contract'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from './ai-vault-search-types'
import { redactForTransport, type SessionSearchTransport } from './ai-vault-search-transport'

export function unavailableSessionSearchStatus(): AiVaultSearchStatus {
  return {
    enabled: false,
    phase: 'idle',
    filesIndexed: 0,
    filesDue: 0,
    filesFailed: 0,
    degradedRoots: [],
    lastReconcileAt: null,
    lastSweepCompletedAt: null,
    generation: 0
  }
}

// Only an explicit unknown-method refusal proves the old host lacks this surface.
function isUnknownMethod(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return error.code === -32601 || error.code === 'method_not_found'
}

export function createSessionSearchClient(
  call: (method: string, params: unknown) => Promise<unknown>,
  transport: SessionSearchTransport
): {
  searchSessions(request: AiVaultSearchRequest): Promise<AiVaultSearchResponse>
  searchStatus(): Promise<AiVaultSearchStatus>
} {
  return {
    searchSessions: async (request) => {
      const parsed = AiVaultSearchRequestSchema.parse(request)
      let raw: unknown
      try {
        raw = await call('aiVault.searchSessions', parsed)
      } catch (error) {
        if (isUnknownMethod(error)) {
          return { kind: 'unavailable', reason: 'no-service' }
        }
        throw error
      }
      const result = AiVaultSearchResponseSchema.parse(raw)
      if (result.kind !== 'results') {
        return result
      }
      const { debug, ...fields } = result
      return {
        ...fields,
        hits: result.hits.map((hit) => redactForTransport(hit, transport)),
        ...(parsed.debug && debug ? { debug } : {})
      }
    },
    searchStatus: async () => {
      try {
        return AiVaultSearchStatusSchema.parse(await call('aiVault.searchStatus', {}))
      } catch (error) {
        if (isUnknownMethod(error)) {
          return unavailableSessionSearchStatus()
        }
        throw error
      }
    }
  }
}
