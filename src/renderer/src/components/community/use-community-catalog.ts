import { watchCommunitySync } from './watch-community-sync'
import { communityRequestResult } from './community-request-result'
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
      const result = await communityRequestResult(async () => {
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
      })
      if (id === request.current) {
        if (!result.ok) {
          setError(result.message)
        }
        setLoading(false)
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
    return watchCommunitySync(client.status, (status) => {
      setSync(status)
      if (!status.running && !refreshing) {
        void load()
      }
    })
  }, [client, refreshing, page?.status.running, load])
  const refresh = async (): Promise<void> => {
    const id = generation.current
    setRefreshing(true)
    setError(null)
    const result = await communityRequestResult(async () => {
      await client.refresh()
      if (id === generation.current) {
        await load()
      }
    })
    if (id === generation.current) {
      if (!result.ok) {
        setError(result.message)
      }
      setRefreshing(false)
    }
  }
  const mutate = useCallback(
    async (action: CommunityFeatureAction): Promise<CommunityFeaturesSnapshot> => {
      const id = generation.current
      const result = await communityRequestResult(() => client.mutate(action))
      if (!result.ok) {
        if (id === generation.current) {
          setError(result.message)
        }
        throw result.error
      }
      if (id === generation.current) {
        setPage((previous) => (previous ? { ...previous, personal: result.value } : previous))
        if (query.view && query.view !== 'explore') {
          await load()
        }
      }
      return result.value
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
