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
import { compatibleSearchAgents } from './ai-vault-search-agent-compatibility'
import { AI_VAULT_AGENTS } from './ai-vault-types'

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
      let hostRequest = parsed
      let raw: unknown
      try {
        const requestedAgents = parsed.filters?.agents
        // IPC and its all-hosts merge are this build; each remote leg negotiates its own host.
        if (transport !== 'ipc' && parsed.filters?.agents?.length) {
          const status = await readSessionSearchStatus(call)
          const agents = compatibleSearchAgents(parsed.filters.agents, status)
          if (agents.length === 0) {
            return requestedAgents?.every((agent) => agent === 'dsh')
              ? emptySessionSearchResults(status.generation)
              : { kind: 'unavailable', reason: 'unsupported-agent' }
          }
          hostRequest = { ...parsed, filters: { ...parsed.filters, agents } }
        }
        raw = await call('aiVault.searchSessions', {
          ...hostRequest,
          includeDshHistory: true,
          supportedAgents: [...AI_VAULT_AGENTS],
          supportsQoderHistory: true,
          supportsJcodeHistory: true
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
    searchStatus: async () =>
      redactStatusForTransport(await readSessionSearchStatus(call), transport)
  }
}

async function readSessionSearchStatus(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<AiVaultSearchStatus> {
  try {
    return AiVaultSearchStatusSchema.parse(await call('aiVault.searchStatus', {}))
  } catch (error) {
    if (isUnknownSessionSearchMethod(error)) {
      return unavailableSessionSearchStatus()
    }
    throw error
  }
}
