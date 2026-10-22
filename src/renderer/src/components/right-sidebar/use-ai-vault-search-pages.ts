import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../../shared/ai-vault-search-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'

export type AiVaultSearchPageRequest = {
  request: AiVaultSearchRequest | null
  scope: ExecutionHostScope | null
}

type SearchPage = {
  hits: AiVaultSearchHit[]
  response: AiVaultSearchResponse | null
  error: boolean
  loading: boolean
}

/** Each host keeps its own cursor and acknowledgement; a changed identity cancels every leg. */
export function useAiVaultSearchPages(
  requests: readonly AiVaultSearchPageRequest[],
  policyKey: string,
  debounceMs = 250
) {
  const [revision, setRevision] = useState(0)
  const identity = useMemo(
    () => ({ requests, policyKey, revision }),
    [requests, policyKey, revision]
  )
  const [state, setState] = useState<{
    identity: typeof identity
    pages: ReadonlyMap<AiVaultSearchPageRequest, SearchPage>
  } | null>(null)
  const loaders = useRef(new Map<AiVaultSearchPageRequest, (cursor: string) => void>())

  useEffect(() => {
    let cancelled = false
    const pageLoaders = loaders.current
    function updatePage(
      target: AiVaultSearchPageRequest,
      update: (previous: SearchPage | undefined) => SearchPage
    ) {
      setState((previous) => {
        const pages = new Map(previous?.identity === identity ? previous.pages : [])
        pages.set(target, update(pages.get(target)))
        return { identity, pages }
      })
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const target of identity.requests) {
      const { request, scope } = target
      if (!request || !scope) {
        continue
      }
      let pending = false
      async function run(cursor?: string) {
        if (pending || cancelled || !request || !scope) {
          return
        }
        pending = true
        updatePage(target, (previous) => ({
          hits: cursor ? (previous?.hits ?? []) : [],
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
          updatePage(target, (previous) => ({
            hits:
              response.kind === 'results'
                ? [...(append ? (previous?.hits ?? []) : []), ...response.hits]
                : [],
            response,
            error: false,
            loading: false
          }))
        } catch {
          if (!cancelled) {
            updatePage(target, () => ({ hits: [], response: null, error: true, loading: false }))
          }
        } finally {
          pending = false
        }
      }
      pageLoaders.set(target, (cursor) => void run(cursor))
      timers.push(setTimeout(() => void run(), debounceMs))
    }
    return () => {
      cancelled = true
      pageLoaders.clear()
      for (const timer of timers) {
        clearTimeout(timer)
      }
    }
  }, [identity, debounceMs])

  return {
    pages: requests.map((target) => {
      const page = state?.identity === identity ? state.pages.get(target) : undefined
      return {
        ...target,
        hits: page?.hits ?? [],
        response: page?.response ?? null,
        error: page?.error ?? false,
        loading: Boolean(target.request && target.scope && (!page || page.loading)),
        removeHit: (hit: AiVaultSearchHit) =>
          setState((previous) => {
            const current = previous?.identity === identity ? previous.pages.get(target) : undefined
            if (!current) {
              return previous
            }
            const pages = new Map(previous?.pages)
            pages.set(target, { ...current, hits: current.hits.filter((entry) => entry !== hit) })
            return { identity, pages }
          }),
        loadMore: () => {
          if (page?.response?.kind === 'results' && page.response.page.cursor) {
            loaders.current.get(target)?.(page.response.page.cursor)
          }
        }
      }
    }),
    retry: () => setRevision((value) => value + 1)
  }
}
