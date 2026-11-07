import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host'
import type {
  AiVaultAgent,
  AiVaultSearchSort,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSearchScopeIdentity } from '../../../../../../shared/ai-vault/search/ai-vault-search-scope'
import { resolveAiVaultSearchSettings } from '../../../../../../shared/ai-vault/search/ai-vault-search-settings'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store/index'
import { useAiVaultAssociationObservation } from '../scanning/ai-vault-association-observation'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'

type SearchIdentity = {
  request: AiVaultSearchRequest | null
  scope: ExecutionHostScope | null
  policyKey: string
  revision: number
}

type SearchPage = {
  identity: SearchIdentity
  hits: AiVaultSearchHit[]
  response: AiVaultSearchResponse | null
  error: boolean
  loading: boolean
}

export function useAiVaultSearch(
  request: AiVaultSearchRequest | null,
  scope: ExecutionHostScope | null,
  policyKey: string
) {
  const associations = useAiVaultAssociationObservation(request ? scope : null)
  const [page, setPage] = useState<SearchPage | null>(null)
  const [revision, setRevision] = useState(0)
  const loadPage = useRef<((cursor: string) => void) | null>(null)
  const identity = useMemo(
    () => ({ request, scope, policyKey, revision }),
    [request, scope, policyKey, revision]
  )

  useEffect(() => {
    const { request, scope } = identity
    if (!request || !scope) {
      // A torn-down search leaves no page behind to revive when its scope returns (#39298).
      setPage(null)
      return
    }
    let cancelled = false
    let pending = false
    let followUp = false
    let started = false
    async function run(cursor?: string) {
      if (pending || cancelled || !request || !scope) {
        return
      }
      pending = true
      started = true
      const revision = associations.getSnapshot()
      const isCurrent = () => !cancelled && revision === associations.getSnapshot()
      setPage((previous) => ({
        identity,
        // A follow-up query keeps the hits already on screen while it runs (#39298).
        hits: previous?.hits ?? [],
        response: null,
        error: false,
        loading: true
      }))
      try {
        let response = await window.api.aiVault.searchSessions({ ...request, cursor }, scope)
        let append = Boolean(cursor)
        if (!isCurrent()) {
          return
        }
        if (response.kind === 'stale-cursor') {
          append = false
          response = await window.api.aiVault.searchSessions(request, scope)
        }
        if (!isCurrent()) {
          return
        }
        setPage((previous) => ({
          identity,
          hits:
            response.kind === 'results'
              ? [
                  ...(append && previous?.identity === identity ? previous.hits : []),
                  ...response.hits
                ]
              : [],
          response,
          error: false,
          loading: false
        }))
      } catch {
        if (isCurrent()) {
          setPage({ identity, hits: [], response: null, error: true, loading: false })
        }
      } finally {
        pending = false
        if (followUp && !cancelled) {
          followUp = false
          void run()
        }
      }
    }
    loadPage.current = (cursor) => void run(cursor)
    const stop = associations.subscribe(() => {
      if (!started) {
        return
      }
      if (pending) {
        followUp = true
      } else {
        void run()
      }
    })
    const timer = setTimeout(() => void run(), 250)
    return () => {
      cancelled = true
      followUp = false
      stop()
      loadPage.current = null
      clearTimeout(timer)
    }
  }, [identity, associations])

  const current = page?.identity === identity ? page : null
  const loading = Boolean(request && scope && (!current || current.loading))
  return {
    // Before the first page of a new query lands, the previous page's hits stay on screen (#39298).
    hits: current ? current.hits : loading && page ? page.hits : [],
    response: current?.response ?? null,
    error: current?.error ?? false,
    loading,
    removeHit: (hit: AiVaultSearchHit) =>
      setPage((previous) =>
        previous?.identity === identity
          ? { ...previous, hits: previous.hits.filter((entry) => entry !== hit) }
          : previous
      ),
    retry: () => setRevision((value) => value + 1),
    loadMore: () => {
      if (current?.response?.kind === 'results' && current.response.page.cursor) {
        loadPage.current?.(current.response.page.cursor)
      }
    }
  }
}

// Answers that a retry from this client cannot change; `not-ready` can, so it keeps searching.
const TITLE_ONLY_UNAVAILABLE_REASONS = new Set<string>(['disabled', 'no-service'])

// All-host hits name their host; single-host responses belong to the addressed host.
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
  const needsLocalConsent =
    executionHostScope === 'local' && !isWebClientLocation() && !policy.enabled
  // A client cannot enable another host’s index; fall back to title filtering when it reports search off (#22453).
  const [titleOnlyScope, setTitleOnlyScope] = useState<ExecutionHostScope | null>(null)
  const titleOnly =
    scope !== null && scope !== ALL_EXECUTION_HOSTS_SCOPE && titleOnlyScope === scope
  const searching = hasQuery && !needsLocalConsent && !titleOnly
  // Callers must memoize within; new objects restart the search before it can settle.
  const request = useMemo(
    () =>
      searching && scope && agents.length > 0
        ? {
            query: trimmed,
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
  // Latch title-only mode during render to skip a second commit per unavailable response.
  const [titleOnlyCheckedFor, setTitleOnlyCheckedFor] = useState<{
    hostSearchOff: boolean
    scope: typeof scope
  } | null>(null)
  if (titleOnlyCheckedFor?.hostSearchOff !== hostSearchOff || titleOnlyCheckedFor.scope !== scope) {
    setTitleOnlyCheckedFor({ hostSearchOff, scope })
    if (hostSearchOff && scope !== ALL_EXECUTION_HOSTS_SCOPE) {
      setTitleOnlyScope(scope)
    }
  }
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
