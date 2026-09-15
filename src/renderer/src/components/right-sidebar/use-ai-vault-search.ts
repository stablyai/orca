import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../shared/ai-vault-search-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
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
      return
    }
    let cancelled = false
    let pending = false
    async function run(cursor?: string) {
      if (pending || cancelled || !request || !scope) {
        return
      }
      pending = true
      setPage((previous) => ({
        identity,
        hits: cursor && previous?.identity === identity ? previous.hits : [],
        response: null,
        error: false,
        loading: true
      }))
      try {
        let response = await window.api.aiVault.searchSessions({ ...request, cursor }, scope)
        let append = Boolean(cursor)
        if (cancelled) {
          return
        }
        if (response.kind === 'stale-cursor') {
          append = false
          response = await window.api.aiVault.searchSessions(request, scope)
        }
        if (cancelled) {
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
        if (!cancelled) {
          setPage({ identity, hits: [], response: null, error: true, loading: false })
        }
      } finally {
        pending = false
      }
    }
    loadPage.current = (cursor) => void run(cursor)
    const timer = setTimeout(() => void run(), 250)
    return () => {
      cancelled = true
      loadPage.current = null
      clearTimeout(timer)
    }
  }, [identity])

  const current = page?.identity === identity ? page : null
  return {
    hits: current?.hits ?? [],
    response: current?.response ?? null,
    error: current?.error ?? false,
    loading: Boolean(request && scope && (!current || current.loading)),
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

/** Under `all` every hit names its own host; a single-host answer belongs to the host we addressed. */
function hitExecutionHostId(hit: AiVaultSearchHit, host: ExecutionHostId | null): ExecutionHostId {
  return host ?? parseExecutionHostId(hit.executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID
}

export function useAiVaultPanelSearch(
  query: string,
  agents: readonly AiVaultAgent[],
  paths: readonly string[] | undefined,
  executionHostScope: ExecutionHostScope
) {
  const settings = useAppStore((state) => state.settings?.aiVaultSearch)
  const policy = resolveAiVaultSearchSettings({ aiVaultSearch: settings })
  const host = parseExecutionHostId(executionHostScope)?.id ?? null
  const scope: ExecutionHostScope | null =
    executionHostScope === ALL_EXECUTION_HOSTS_SCOPE ? ALL_EXECUTION_HOSTS_SCOPE : host
  const searching = query.trim().length > 0
  const localConsent = executionHostScope === 'local' && !isWebClientLocation() && !policy.enabled
  const request = useMemo(
    () =>
      searching && scope && !localConsent && agents.length > 0
        ? {
            query: query.trim(),
            filters: { agents: [...agents], ...(paths ? { scopePaths: [...paths] } : {}) }
          }
        : null,
    [searching, scope, localConsent, agents, query, paths]
  )
  const search = useAiVaultSearch(request, scope, JSON.stringify(policy))
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
    localConsent,
    host,
    resetKey: JSON.stringify([scope, request])
  }
}
