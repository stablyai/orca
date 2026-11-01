import { useLayoutEffect, useRef } from 'react'

/**
 * A mounted value control, as `orca plugin shot --act` drives it: through the control's own edit
 * path, so what Orca shows and the edit ids the guest sees match a person's input exactly.
 */
export type PluginDeclarativeActTarget = {
  value(): unknown
  /** False when the value is not this control's kind (text, flag, number or keys). */
  change(next: unknown): boolean
  readOnly(): boolean
}

/** A drawn node's `props` object, by identity: unique per node per tree, and dropped with it. */
export type PluginDeclarativeDrawnProps = Readonly<Record<string, unknown>>

const targets = new WeakMap<PluginDeclarativeDrawnProps, PluginDeclarativeActTarget>()

export function pluginDeclarativeActTarget(
  props: PluginDeclarativeDrawnProps
): PluginDeclarativeActTarget | null {
  return targets.get(props) ?? null
}

function isSameKind<T>(next: unknown, fallback: T): next is T {
  if (Array.isArray(fallback)) {
    return Array.isArray(next) && next.every((entry) => typeof entry === 'string')
  }
  return typeof next === typeof fallback
}

/** Registers the control drawn for `props` while it is mounted. */
export function usePluginDeclarativeActTarget<T>(
  props: PluginDeclarativeDrawnProps | undefined,
  fallback: T,
  live: { value: T; change: (next: T) => void; readOnly: boolean }
): void {
  const liveRef = useRef(live)
  useLayoutEffect(() => {
    liveRef.current = live
  })
  useLayoutEffect(() => {
    if (!props) {
      return undefined
    }
    const target: PluginDeclarativeActTarget = {
      value: () => liveRef.current.value,
      readOnly: () => liveRef.current.readOnly,
      change: (next) => {
        if (!isSameKind(next, fallback)) {
          return false
        }
        liveRef.current.change(next)
        return true
      }
    }
    targets.set(props, target)
    return () => {
      if (targets.get(props) === target) {
        targets.delete(props)
      }
    }
  }, [props, fallback])
}
