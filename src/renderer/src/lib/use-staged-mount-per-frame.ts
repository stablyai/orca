import { startTransition, useEffect, useMemo, useRef, useState } from 'react'

const EMPTY: ReadonlySet<never> = new Set()

/**
 * Which of the in-range keys may mount their heavy content right now.
 *
 * Mounting N terminals (or N card lanes) in one commit is N resizes, PTY
 * subscriptions and buffer serializations at once — the entry jank. So keys
 * enter the rendered set one per animation frame, inside a transition, and
 * leave it as soon as the caller drops them from range. `enabled` false
 * empties the set and stops staging.
 */
export function useStagedMountPerFrame<K extends string>(
  mountedKeys: readonly K[],
  enabled = true
): ReadonlySet<K> {
  const [rendered, setRendered] = useState<ReadonlySet<K>>(EMPTY)
  const renderedRef = useRef(rendered)
  renderedRef.current = rendered
  // Why join: callers rebuild the array each render; its contents are the dependency.
  const mountedKey = useMemo(() => mountedKeys.join('\0'), [mountedKeys])
  const mountedSet = useMemo(() => new Set<K>(mountedKeys), [mountedKeys])
  const mountedRef = useRef<ReadonlySet<K>>(mountedSet)
  const enabledRef = useRef(enabled)

  useEffect(() => {
    mountedRef.current = mountedSet
    enabledRef.current = enabled
    if (!enabled) {
      setRendered(EMPTY)
      return
    }
    // Prune first, synchronously: an unmounted key must not linger rendered.
    if ([...renderedRef.current].some((key) => !mountedSet.has(key))) {
      setRendered((current) => new Set([...current].filter((key) => mountedSet.has(key))))
    }
    const missing = mountedKeys.filter((key) => !renderedRef.current.has(key))
    let next = 0
    let frame = 0
    const renderNext = (): void => {
      const key = missing[next]
      next += 1
      if (key === undefined) {
        return
      }
      startTransition(() => {
        setRendered((current) =>
          enabledRef.current && mountedRef.current.has(key) && !current.has(key)
            ? new Set(current).add(key)
            : current
        )
      })
      if (next < missing.length) {
        frame = window.requestAnimationFrame(renderNext)
      }
    }
    if (missing.length > 0) {
      frame = window.requestAnimationFrame(renderNext)
    }
    return () => window.cancelAnimationFrame(frame)
  }, [mountedKey, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  return rendered
}
