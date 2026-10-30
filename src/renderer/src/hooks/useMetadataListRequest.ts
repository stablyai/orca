import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { getFreshMetadata, loadMetadata, type MetadataRequestStore } from './metadata-request-cache'

export type MetadataListState<T> = {
  data: T[]
  loading: boolean
  error: string | null
}

type MetadataListRequest<T> = {
  cacheKey: string | null
  store: MetadataRequestStore<T[]>
  load: () => Promise<T[]>
  errorFallback: string
}

export function useMetadataListRequest<T>({
  cacheKey,
  store,
  load,
  errorFallback
}: MetadataListRequest<T>): MetadataListState<T> & { resolvedKey: string | null } {
  const [state, setState] = useState<MetadataListState<T> & { resolvedKey: string | null }>({
    data: [],
    loading: false,
    error: null,
    resolvedKey: null
  })
  const activeKeyRef = useRef<string | null>(null)
  const loadLatest = useEffectEvent(load)

  useEffect(() => {
    if (cacheKey === null) {
      return
    }

    const cached = getFreshMetadata(store, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null, resolvedKey: cacheKey })
      }
      activeKeyRef.current = cacheKey
      return
    }
    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState((current) => ({
      ...current,
      data: current.data.length ? [] : current.data,
      loading: true,
      error: null,
      resolvedKey: null
    }))
    void loadMetadata(store, cacheKey, () => loadLatest())
      .then((data) => {
        if (activeKeyRef.current === requestKey) {
          setState({ data, loading: false, error: null, resolvedKey: requestKey })
        }
      })
      .catch((error: unknown) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : errorFallback
        }))
      })
  }, [cacheKey, errorFallback, store])

  return state
}
