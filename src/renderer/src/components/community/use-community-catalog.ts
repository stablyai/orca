import type { CommunitySyncStatus } from '../../../../shared/community-catalog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CommunityPage, CommunityQuery } from '../../../../shared/community-operations'
import type {
  CommunityFeatureAction,
  CommunityFeaturesSnapshot
} from '../../../../shared/community-features'
import { communityClient } from './community-client'
export function useCommunityCatalog(target: RuntimeClientTarget, query: CommunityQuery) {
  const client = useMemo(() => communityClient(target), [target])
  const [page, setPage] = useState<CommunityPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sync, setSync] = useState<CommunitySyncStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const request = useRef(0)
  const generation = useRef(0)
  const load = useCallback(
    async (append = false, offset = 0) => {
      const id = ++request.current
      setLoading(true)
      setError(null)
      try {
        const value = await client.list({ ...query, offset })
        if (id !== request.current) {
          return
        }
        setPage((previous) => ({
          ...value,
          rows:
            append && previous
              ? [
                  ...previous.rows,
                  ...value.rows.filter(
                    (row) => !previous.rows.some((old) => old.number === row.number)
                  )
                ]
              : value.rows
        }))
      } catch (cause) {
        if (id === request.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (id === request.current) {
          setLoading(false)
        }
      }
    },
    [client, query]
  )
  const invalidate = useCallback(() => {
    request.current++
    generation.current++
  }, [])
  useEffect(() => {
    setPage(null)
    setRefreshing(false)
    void load()
    return () => {
      invalidate()
    }
  }, [load, invalidate])
  useEffect(() => {
    if (!refreshing && !page?.status.running) {
      return
    }
    let cancelled = false
    let pending = false
    const timer = setInterval(() => {
      if (pending) {
        return
      }
      pending = true
      void client
        .status()
        .then((status) => {
          if (!cancelled) {
            setSync(status)
            if (!status.running && !refreshing) {
              void load()
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false
        })
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, refreshing, page?.status.running, load])
  const refresh = async (): Promise<void> => {
    const id = generation.current
    setRefreshing(true)
    setError(null)
    try {
      await client.refresh()
      if (id === generation.current) {
        await load()
      }
    } catch (cause) {
      if (id === generation.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (id === generation.current) {
        setRefreshing(false)
      }
    }
  }
  const mutate = useCallback(
    async (action: CommunityFeatureAction): Promise<CommunityFeaturesSnapshot> => {
      const id = generation.current
      try {
        const personal = await client.mutate(action)
        if (id !== generation.current) {
          return personal
        }
        setPage((previous) => (previous ? { ...previous, personal } : previous))
        if (query.view && query.view !== 'explore') {
          await load()
        }
        return personal
      } catch (cause) {
        if (id === generation.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
        throw cause
      }
    },
    [client, load, query.view]
  )
  return {
    page,
    error,
    loading,
    refreshing,
    sync,
    refresh,
    mutate,
    loadMore: () => load(true, page?.nextOffset ?? 0),
    retry: () => load(),
    cancel: () => client.cancel()
  }
}
