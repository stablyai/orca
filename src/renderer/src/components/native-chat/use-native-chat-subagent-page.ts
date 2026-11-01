import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

const INITIAL_LIMIT = 40
const PAGE_LIMIT = 60

export type NativeChatSubagentPageRead = (
  agentId: string,
  limit: number,
  beforeOffset?: number
) => Promise<
  { messages: NativeChatMessage[]; hasMore?: boolean; beforeOffset?: number } | { error: string }
>

type PageState = {
  agentId: string
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
  loading: boolean
  loadingEarlier: boolean
}

/** One child's paged transcript. A null reader leaves the caller on rows already in the parent. */
export function useNativeChatSubagentPage(
  agentId: string | null,
  readPage: NativeChatSubagentPageRead | null | undefined
): {
  messages: readonly NativeChatMessage[] | null
  loading: boolean
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
} {
  const [page, setPage] = useState<PageState | null>(null)
  const readRef = useRef(readPage)
  readRef.current = readPage
  const pageRef = useRef(page)
  pageRef.current = page
  const pagingRef = useRef(false)

  useEffect(() => {
    const read = readRef.current
    if (!agentId || !read) {
      setPage(null)
      return
    }
    let cancelled = false
    setPage({
      agentId,
      messages: [],
      hasMore: false,
      beforeOffset: 0,
      loading: true,
      loadingEarlier: false
    })
    void read(agentId, INITIAL_LIMIT).then((result) => {
      if (cancelled) {
        return
      }
      if ('error' in result) {
        setPage({
          agentId,
          messages: [],
          hasMore: false,
          beforeOffset: 0,
          loading: false,
          loadingEarlier: false
        })
        return
      }
      setPage({
        agentId,
        messages: result.messages,
        hasMore: result.hasMore === true,
        beforeOffset: result.beforeOffset ?? 0,
        loading: false,
        loadingEarlier: false
      })
    })
    return () => {
      cancelled = true
    }
  }, [agentId, readPage])

  const loadEarlier = useCallback(async (): Promise<NativeChatOlderPageResult> => {
    const read = readRef.current
    const current = pageRef.current
    if (
      pagingRef.current ||
      !agentId ||
      !read ||
      !current ||
      current.agentId !== agentId ||
      current.loading ||
      current.loadingEarlier ||
      !current.hasMore
    ) {
      return 'exhausted'
    }
    pagingRef.current = true
    const beforeOffset = current.beforeOffset
    const pending = { ...current, loadingEarlier: true }
    pageRef.current = pending
    setPage(pending)
    try {
      const result = await read(agentId, PAGE_LIMIT, beforeOffset)
      const latest = pageRef.current
      if (!latest || latest.agentId !== agentId || latest.beforeOffset !== beforeOffset) {
        return 'superseded'
      }
      if ('error' in result) {
        const failed = { ...latest, loadingEarlier: false }
        pageRef.current = failed
        setPage(failed)
        return 'failed'
      }
      const seen = new Set(latest.messages.map((entry) => entry.id))
      const older = result.messages.filter((entry) => !seen.has(entry.id))
      const next = {
        agentId,
        messages: [...older, ...latest.messages],
        hasMore: result.hasMore === true,
        beforeOffset: result.beforeOffset ?? latest.beforeOffset,
        loading: false,
        loadingEarlier: false
      }
      pageRef.current = next
      setPage(next)
      return older.length > 0 ? 'applied' : 'unchanged'
    } finally {
      pagingRef.current = false
    }
  }, [agentId])

  if (!readPage || !agentId || !page || page.agentId !== agentId) {
    return {
      messages: null,
      loading: Boolean(readPage && agentId),
      hasMore: false,
      loadingEarlier: false,
      loadEarlier
    }
  }
  return {
    messages: page.messages,
    loading: page.loading,
    hasMore: page.hasMore,
    loadingEarlier: page.loadingEarlier,
    loadEarlier
  }
}
