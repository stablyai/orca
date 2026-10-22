import { useEffect, useMemo, useState } from 'react'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest
} from '../../../../shared/ai-vault-search-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type {
  AiVaultAgent,
  AiVaultSearchSort,
  AiVaultSession
} from '../../../../shared/ai-vault-types'
import type { AiVaultSearchScopeIdentity } from '../../../../shared/ai-vault-search-scope'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'

export { useAiVaultSearchPages } from './use-ai-vault-search-pages'
import { useAiVaultSearchPages } from './use-ai-vault-search-pages'

export function useAiVaultSearch(
  request: AiVaultSearchRequest | null,
  scope: ExecutionHostScope | null,
  policyKey: string,
  debounceMs = 250
) {
  const requests = useMemo(() => [{ request, scope }], [request, scope])
  const { pages, retry } = useAiVaultSearchPages(requests, policyKey, debounceMs)
  const { hits, response, error, loading, removeHit, loadMore } = pages[0]
  return { hits, response, error, loading, removeHit, loadMore, retry }
}

// Answers that a retry from this client cannot change; `not-ready` can, so it keeps searching.
const TITLE_ONLY_UNAVAILABLE_REASONS = new Set<string>(['disabled', 'no-service'])

/** This desktop's own index answers only once the user has turned indexing on; other hosts decide for themselves. */
export function aiVaultSearchNeedsLocalConsent(
  executionHostScope: ExecutionHostScope,
  localPolicyEnabled: boolean
): boolean {
  return (
    executionHostScope === LOCAL_EXECUTION_HOST_ID && !isWebClientLocation() && !localPolicyEnabled
  )
}

/** Under `all` every hit names its own host; a single-host answer belongs to the host we addressed. */
function hitExecutionHostId(hit: AiVaultSearchHit, host: ExecutionHostId | null): ExecutionHostId {
  return host ?? parseExecutionHostId(hit.executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID
}

export function useAiVaultPanelSearch(
  query: string,
  agents: readonly AiVaultAgent[],
  /** Which scope the host resolves; undefined searches everything it has. */
  within: AiVaultSearchScopeIdentity | undefined,
  executionHostScope: ExecutionHostScope,
  sort: AiVaultSearchSort
) {
  const settings = useAppStore((state) => state.settings?.aiVaultSearch)
  const policy = resolveAiVaultSearchSettings({ aiVaultSearch: settings })
  const host = parseExecutionHostId(executionHostScope)?.id ?? null
  const scope: ExecutionHostScope | null =
    executionHostScope === ALL_EXECUTION_HOSTS_SCOPE ? ALL_EXECUTION_HOSTS_SCOPE : host
  const trimmed = query.trim()
  const hasQuery = trimmed.length > 0
  const needsLocalConsent = aiVaultSearchNeedsLocalConsent(executionHostScope, policy.enabled)
  // Why: another computer's index is not this client's to turn on (a relay keeps its
  // own off by design), so once a single host says its search is off, the box goes
  // back to the title filter for that host instead of walling the list (#22453).
  const [titleOnlyScope, setTitleOnlyScope] = useState<ExecutionHostScope | null>(null)
  const titleOnly =
    scope !== null && scope !== ALL_EXECUTION_HOSTS_SCOPE && titleOnlyScope === scope
  // Until indexing is on the box is still the legacy title filter, not index search.
  const searching = hasQuery && !needsLocalConsent && !titleOnly
  // `within` is memoized by the caller; a fresh object per render would restart
  // the search on every render and never let one settle.
  const request = useMemo(
    () =>
      searching && scope && agents.length > 0
        ? {
            query: trimmed,
            // Relevance is the host's own default, so only the other order travels.
            filters: { agents: [...agents], ...(sort === 'relevance' ? {} : { sort }) },
            ...(within ? { within } : {})
          }
        : null,
    [searching, scope, agents, trimmed, within, sort]
  )
  const search = useAiVaultSearch(request, scope, JSON.stringify(policy))
  const hostSearchOff =
    search.response?.kind === 'unavailable' &&
    TITLE_ONLY_UNAVAILABLE_REASONS.has(search.response.reason)
  useEffect(() => {
    if (hostSearchOff && scope !== ALL_EXECUTION_HOSTS_SCOPE) {
      setTitleOnlyScope(scope)
    }
  }, [hostSearchOff, scope])
  const sessions = useMemo(
    () => search.hits.map((hit) => aiVaultSearchHitToSession(hit, hitExecutionHostId(hit, host))),
    [search.hits, host]
  )
  const searchHits = useMemo(
    () => new Map(sessions.map((session, index) => [session.id, search.hits[index]])),
    [sessions, search.hits]
  )
  return {
    ...search,
    onDeleted: (session: AiVaultSession) => {
      const hit = searchHits.get(session.id)
      if (hit) {
        search.removeHit(hit)
      }
    },
    sessions,
    searchHits,
    searching,
    hasQuery,
    needsLocalConsent,
    titleOnly: hasQuery && titleOnly,
    host,
    resetKey: JSON.stringify([scope, request])
  }
}
