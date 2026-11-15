import { useEffect, useEffectEvent, useState } from 'react'

export type HoverPreviewState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'failed' }

/** Paints a cached answer at once, then refreshes it; `key` names what is being previewed. */
export function useNativeChatHoverPreview<T>(
  key: string,
  read: () => T | null,
  load: () => Promise<T | null>
): { state: HoverPreviewState<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<HoverPreviewState<T>>(() => {
    const cached = read()
    return cached ? { status: 'ready', value: cached } : { status: 'loading' }
  })
  const startLoad = useEffectEvent(load)
  useEffect(() => {
    let cancelled = false
    startLoad().then(
      (value) => !cancelled && setState(value ? { status: 'ready', value } : { status: 'failed' }),
      () => !cancelled && setState({ status: 'failed' })
    )
    return () => {
      cancelled = true
    }
  }, [key, attempt])
  return {
    state,
    retry: () => {
      setState({ status: 'loading' })
      setAttempt((value) => value + 1)
    }
  }
}
