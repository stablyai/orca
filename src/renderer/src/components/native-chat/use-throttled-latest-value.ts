import { useDeferredValue } from 'react'

/** Defers rapidly-changing stream frames so React can coalesce intermediate
 *  values instead of re-projecting the transcript for every provider part.
 *
 *  Mirrors mobile/src/session/use-throttled-latest-value.ts. Kept duplicated
 *  rather than hoisted: src/shared has zero React imports by design (it is
 *  loaded by main, cli and relay), so a hook cannot live there. */
export function useThrottledLatestValue<T>(value: T, _intervalMs: number): T {
  const deferred = useDeferredValue(value)
  // A completed turn must retire its streaming bubble synchronously.
  return value == null ? value : deferred
}
