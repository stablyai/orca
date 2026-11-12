import { useEffect, useEffectEvent, useState } from 'react'

export type HoverPreviewState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'failed' }

function initialState<T>(read: () => T | null): HoverPreviewState<T> {
  const cached = read()
  return cached ? { status: 'ready', value: cached } : { status: 'loading' }
}

/** Paints a cached answer at once, then refreshes it; `key` names what is being previewed.
 *  A new key drops the old answer at once, and an answer for an earlier key is ignored. */
export function useNativeChatHoverPreview<T>(
  key: string,
  read: () => T | null,
  load: () => Promise<T | null>
): { state: HoverPreviewState<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [current, setCurrent] = useState(() => ({ key, state: initialState(read) }))
  let state = current.state
  if (current.key !== key) {
    // Reset during render: a reference still streaming in, or a new account, must never paint the old answer.
    state = initialState(read)
    setCurrent({ key, state })
  }
  const startLoad = useEffectEvent(load)
  useEffect(() => {
    let cancelled = false
    const settle = (next: HoverPreviewState<T>): void => {
      if (!cancelled) {
        setCurrent((previous) => (previous.key === key ? { key, state: next } : previous))
      }
    }
    startLoad().then(
      (value) => settle(value ? { status: 'ready', value } : { status: 'failed' }),
      () => settle({ status: 'failed' })
    )
    return () => {
      cancelled = true
    }
  }, [key, attempt])
  return {
    state,
    retry: () => {
      setCurrent({ key, state: { status: 'loading' } })
      setAttempt((value) => value + 1)
    }
  }
}
