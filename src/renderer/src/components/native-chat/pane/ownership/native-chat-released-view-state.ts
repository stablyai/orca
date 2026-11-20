import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'

// Why: chat views are released while hidden to bound memory; small view choices (expanded turns, goal entry)
// come back with them instead of resetting. Values are small, and the oldest are dropped past the cap.
const MAX_REMEMBERED = 512
const remembered = new Map<string, unknown>()

/** `useState` whose value outlives the view under `key`; a different key starts from its own remembered value. */
export function useReleasedViewState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const read = (): T => (remembered.has(key) ? (remembered.get(key) as T) : initial)
  const [state, setState] = useState(() => ({ key, value: read() }))
  // A session change in the same view reads that session's value, as a fresh view would.
  const current = state.key === key ? state : { key, value: read() }
  if (current !== state) {
    setState(current)
  }
  useEffect(() => {
    remembered.delete(current.key)
    remembered.set(current.key, current.value)
    if (remembered.size > MAX_REMEMBERED) {
      remembered.delete(remembered.keys().next().value as string)
    }
  }, [current.key, current.value])
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) =>
      setState((previous) => ({
        key: previous.key,
        value:
          typeof action === 'function' ? (action as (value: T) => T)(previous.value) : action
      })),
    []
  )
  return [current.value, setValue]
}
