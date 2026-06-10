import { useReducer, useEffect, useCallback } from 'react'

export type IdeDiffRequest = {
  requestId: string
  worktreeId: string
  oldPath: string
  newPath: string
  newContents: string
}

type State = {
  requests: IdeDiffRequest[]
}

type Action =
  | { type: 'open'; requestId: string; worktreeId: string; oldPath: string; newPath: string; newContents: string }
  | { type: 'resolve'; requestId: string }

export function reduceIdeDiffRequest(state: State, action: Action): State {
  switch (action.type) {
    case 'open':
      return {
        requests: [
          ...state.requests,
          {
            requestId: action.requestId,
            worktreeId: action.worktreeId,
            oldPath: action.oldPath,
            newPath: action.newPath,
            newContents: action.newContents,
          },
        ],
      }
    case 'resolve':
      return { requests: state.requests.filter((r) => r.requestId !== action.requestId) }
  }
}

export function useClaudeIdeDiff(): {
  requests: IdeDiffRequest[]
  resolve: (requestId: string, worktreeId: string, verdict: 'keep' | 'reject') => void
} {
  const [state, dispatch] = useReducer(reduceIdeDiffRequest, { requests: [] })

  useEffect(() => {
    const unsubscribe = window.api.claudeIde.onOpenDiff(
      (payload: { worktreeId: string; requestId: string; oldPath: string; newPath: string; newContents: string }) => {
        dispatch({
          type: 'open',
          requestId: payload.requestId,
          worktreeId: payload.worktreeId,
          oldPath: payload.oldPath,
          newPath: payload.newPath,
          newContents: payload.newContents,
        })
      }
    )
    return unsubscribe
  }, [])

  const resolve = useCallback(
    (requestId: string, worktreeId: string, verdict: 'keep' | 'reject') => {
      window.api.claudeIde.reply({ kind: 'verdict', worktreeId, requestId, value: verdict })
      dispatch({ type: 'resolve', requestId })
    },
    []
  )

  return { requests: state.requests, resolve }
}
