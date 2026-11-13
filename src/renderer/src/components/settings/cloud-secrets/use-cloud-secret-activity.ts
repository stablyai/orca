import { useCallback, useEffect, useState } from 'react'
import type {
  CloudSecretActivityView,
  CloudSecretEvent,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { CloudSecretsApi } from './use-cloud-secrets'

export type CloudSecretActivityModel = {
  status: 'loading' | 'ready' | 'failed'
  events: CloudSecretEvent[]
  error: CloudSecretsErrorCode | null
  /** True while an older page loads. */
  loadingMore: boolean
  /** Null when there is nothing older (within the 90-day window). */
  loadMore: (() => void) | null
  reload: () => void
}

/** Secret activity for `view`, newest first, one page at a time. */
export function useCloudSecretActivity(
  api: CloudSecretsApi,
  view: CloudSecretActivityView
): CloudSecretActivityModel {
  const [state, setState] = useState<{
    view: CloudSecretActivityView
    status: 'loading' | 'ready' | 'failed'
    events: CloudSecretEvent[]
    cursor: string | null
    error: CloudSecretsErrorCode | null
    loadingMore: boolean
  }>({ view, status: 'loading', events: [], cursor: null, error: null, loadingMore: false })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ view, status: 'loading', events: [], cursor: null, error: null, loadingMore: false })
    void api.activity({ view }).then(
      (result) => {
        if (cancelled) {
          return
        }
        setState(
          result.ok
            ? {
                view,
                status: 'ready',
                events: result.value.events,
                cursor: result.value.nextCursor,
                error: null,
                loadingMore: false
              }
            : { view, status: 'failed', events: [], cursor: null, error: result.error, loadingMore: false }
        )
      },
      () =>
        !cancelled &&
        setState({ view, status: 'failed', events: [], cursor: null, error: 'unknown', loadingMore: false })
    )
    return () => {
      cancelled = true
    }
  }, [api, view, generation])

  const cursor = state.view === view && state.status === 'ready' ? state.cursor : null
  const loadMore = useCallback(() => {
    if (!cursor) {
      return
    }
    setState((current) => ({ ...current, loadingMore: true }))
    void api.activity({ view, cursor }).then(
      (result) =>
        setState((current) =>
          // A page for a view the user has left, or after a reload, is dropped.
          current.view !== view || current.cursor !== cursor
            ? current
            : result.ok
              ? {
                  ...current,
                  events: [...current.events, ...result.value.events],
                  cursor: result.value.nextCursor,
                  loadingMore: false
                }
              : { ...current, error: result.error, loadingMore: false }
        ),
      () => setState((current) => ({ ...current, error: 'unknown', loadingMore: false }))
    )
  }, [api, view, cursor])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  const current = state.view === view
  return {
    status: current ? state.status : 'loading',
    events: current ? state.events : [],
    error: current ? state.error : null,
    loadingMore: current && state.loadingMore,
    loadMore: cursor ? loadMore : null,
    reload
  }
}
