import { useCallback, useMemo, useRef, useState } from 'react'
import type { NativeChatTurnLifecycle } from '../../../../shared/native-chat-types'

type TranscriptLifecycleState = {
  lifecycle?: NativeChatTurnLifecycle
}

type TranscriptLifecycleControl = {
  reset: () => void
  replace: (lifecycle: NativeChatTurnLifecycle | undefined) => void
  append: (lifecycle: NativeChatTurnLifecycle | undefined) => void
  revision: () => number
  replaceFromPagination: (lifecycle: NativeChatTurnLifecycle | undefined, revision: number) => void
}

export function useNativeChatTranscriptLifecycle(): readonly [
  NativeChatTurnLifecycle | undefined,
  TranscriptLifecycleControl
] {
  const [state, setState] = useState<TranscriptLifecycleState>({})
  // Pagination may carry older completion boundaries; apply them only if no live lifecycle write intervened.
  const revisionRef = useRef(0)

  const replace = useCallback((lifecycle: NativeChatTurnLifecycle | undefined): void => {
    revisionRef.current += 1
    setState({ lifecycle })
  }, [])
  const reset = useCallback((): void => replace(undefined), [replace])
  const append = useCallback((lifecycle: NativeChatTurnLifecycle | undefined): void => {
    if (!lifecycle) {
      return
    }
    revisionRef.current += 1
    setState({ lifecycle })
  }, [])
  const revision = useCallback((): number => revisionRef.current, [])
  const replaceFromPagination = useCallback(
    (lifecycle: NativeChatTurnLifecycle | undefined, expectedRevision: number): void => {
      if (!lifecycle || revisionRef.current !== expectedRevision) {
        return
      }
      revisionRef.current += 1
      setState((current) => ({ ...current, lifecycle }))
    },
    []
  )

  const control = useMemo<TranscriptLifecycleControl>(
    () => ({ reset, replace, append, revision, replaceFromPagination }),
    [append, replace, replaceFromPagination, reset, revision]
  )
  return [state.lifecycle, control]
}
