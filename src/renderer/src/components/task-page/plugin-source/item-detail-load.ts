import { useCallback, useEffect, useRef, useState } from 'react'

import { useAppStore } from '@/store'
import type {
  PluginTaskComment,
  PluginTaskItemDetail,
  PluginTaskSourceResult
} from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceLoadError } from '@/store/slices/plugin-task-sources-slice-contract'

export type PluginTaskItemDetailState = {
  detail: PluginTaskItemDetail | null
  detailLoading: boolean
  detailError: PluginTaskSourceLoadError | null
  comments: PluginTaskComment[]
  commentsLoading: boolean
  commentsError: PluginTaskSourceLoadError | null
}

export type PluginTaskItemDetailView = PluginTaskItemDetailState & {
  /** Shows a just-posted comment without a second round trip. Re-sorted on the
   *  source's own `createdAt`, never appended blindly at the end; a no-op if
   *  the id is already present, so it stays safe to call after a re-fetch
   *  that may already carry the same comment. */
  appendComment: (comment: PluginTaskComment) => void
  /** Re-runs `listComments`, for a caller with independent evidence the source
   *  is reachable again (a post that just succeeded). Returns the envelope so
   *  the caller can tell a cleared outage from one that persists. */
  retryComments: () => Promise<PluginTaskSourceResult<PluginTaskComment[]>>
}

const LOADING: PluginTaskItemDetailState = {
  detail: null,
  detailLoading: true,
  detailError: null,
  comments: [],
  commentsLoading: true,
  commentsError: null
}

function byOldestFirst(a: PluginTaskComment, b: PluginTaskComment): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt)
}

/**
 * Loads the body and the comments of one contributed item as two independent
 * requests. Partial success is the normal case, so each half keeps its own
 * error and neither failure blanks the other.
 *
 * Callers mount this per item — keyed by item id — so a second item never
 * shows the first one's body while its own request is in flight.
 */
export function usePluginTaskItemDetail(itemId: string): PluginTaskItemDetailView {
  const getItem = useAppStore((state) => state.getPluginTaskSourceItem)
  const listComments = useAppStore((state) => state.listPluginTaskSourceComments)
  const [state, setState] = useState<PluginTaskItemDetailState>(LOADING)
  const mounted = useRef(true)

  useEffect(() => {
    let current = true
    mounted.current = true

    void getItem(itemId).then((result) => {
      if (!current) {
        return
      }
      setState((previous) => ({
        ...previous,
        detail: result.ok ? result.data : null,
        detailError: result.ok ? null : { code: result.code, message: result.message },
        detailLoading: false
      }))
    })

    void listComments(itemId).then((result) => {
      if (!current) {
        return
      }
      setState((previous) => ({
        ...previous,
        comments: result.ok ? [...result.data].sort(byOldestFirst) : [],
        commentsError: result.ok ? null : { code: result.code, message: result.message },
        commentsLoading: false
      }))
    })

    return () => {
      current = false
      mounted.current = false
    }
  }, [itemId, getItem, listComments])

  const appendComment = useCallback((comment: PluginTaskComment) => {
    setState((previous) =>
      previous.comments.some((existing) => existing.id === comment.id)
        ? previous
        : { ...previous, comments: [...previous.comments, comment].sort(byOldestFirst) }
    )
  }, [])

  const retryComments = useCallback(async (): Promise<
    PluginTaskSourceResult<PluginTaskComment[]>
  > => {
    const result = await listComments(itemId)
    if (mounted.current) {
      setState((previous) => ({
        ...previous,
        comments: result.ok ? [...result.data].sort(byOldestFirst) : previous.comments,
        commentsError: result.ok ? null : { code: result.code, message: result.message }
      }))
    }
    return result
  }, [itemId, listComments])

  return { ...state, appendComment, retryComments }
}
