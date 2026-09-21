import { useCallback, useEffect, useState } from 'react'

import { useAppStore } from '@/store'
import type {
  PluginTaskComment,
  PluginTaskItemDetail
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
   *  source's own `createdAt`, never appended blindly at the end. */
  appendComment: (comment: PluginTaskComment) => void
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

  useEffect(() => {
    let current = true

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
    }
  }, [itemId, getItem, listComments])

  const appendComment = useCallback((comment: PluginTaskComment) => {
    setState((previous) => ({
      ...previous,
      comments: [...previous.comments, comment].sort(byOldestFirst)
    }))
  }, [])

  return { ...state, appendComment }
}
