import { useEffect, useState } from 'react'
import type { PluginTaskDetail } from '../../../../../shared/plugins/plugin-task-source'
import type { ActivePluginTaskSource } from '@/store/plugin-task-sources'
import { pluginTaskErrorMessage } from './plugin-task-error-message'

export type PluginTaskDetailState = {
  detail: PluginTaskDetail | null
  loading: boolean
  error: string | null
}

const EMPTY: PluginTaskDetailState = { detail: null, loading: false, error: null }
const LOADING: PluginTaskDetailState = { detail: null, loading: true, error: null }

/** Loads the open item's detail; state from a previously open item is never returned. */
export function usePluginTaskDetail(
  source: ActivePluginTaskSource,
  itemId: string | null,
  /** Bump to refetch the same item; its last detail stays shown meanwhile. */
  revision = 0
): PluginTaskDetailState {
  const [state, setState] = useState<PluginTaskDetailState & { itemId: string | null }>({
    ...EMPTY,
    itemId: null
  })
  useEffect(() => {
    if (!itemId) {
      return
    }
    let cancelled = false
    window.api.plugins
      .getTaskSourceItem({ pluginKey: source.pluginKey, sourceId: source.sourceId, itemId })
      .then((detail) => {
        if (!cancelled) {
          setState({ detail, loading: false, error: null, itemId })
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setState({
            detail: null,
            loading: false,
            error: pluginTaskErrorMessage(failure),
            itemId
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [itemId, revision, source.pluginKey, source.sourceId])
  if (!itemId) {
    return EMPTY
  }
  return state.itemId === itemId ? state : LOADING
}
