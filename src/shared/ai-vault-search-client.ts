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
import {
  redactForTransport,
  redactStatusForTransport,
  type SessionSearchTransport
} from './ai-vault-search-transport'

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

export function emptySessionSearchResults(generation: number): AiVaultSearchResponse {
  return {
    kind: 'results',
    hits: [],
    page: { cursor: null, hasMore: false },
    generation,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 0
  }
}

// Only an explicit unknown-method refusal proves the old host lacks this surface.
export function isUnknownSessionSearchMethod(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return error.code === -32601 || error.code === 'method_not_found'
}

export function createSessionSearchClient(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
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
        let filters = parsed.filters
        if (filters?.agents?.includes('dsh')) {
          const status = AiVaultSearchStatusSchema.parse(await call('aiVault.searchStatus', {}))
          if (!status.dshHistory) {
            const agents = filters.agents.filter((agent) => agent !== 'dsh')
            if (!agents.length) {
              return emptySessionSearchResults(status.generation)
            }
            filters = { ...filters, agents }
          }
        }
        raw = await call('aiVault.searchSessions', {
          ...parsed,
          ...(filters ? { filters } : {}),
          includeDshHistory: true
        })
      } catch (error) {
        if (isUnknownSessionSearchMethod(error)) {
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
        return redactStatusForTransport(
          AiVaultSearchStatusSchema.parse(await call('aiVault.searchStatus', {})),
          transport
        )
      } catch (error) {
        if (isUnknownSessionSearchMethod(error)) {
          return unavailableSessionSearchStatus()
        }
        throw error
      }
    }
  }
}
