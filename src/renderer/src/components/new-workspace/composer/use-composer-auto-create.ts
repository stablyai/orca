import { useEffect, useRef } from 'react'

// Long enough for project, host and agent defaults to settle; past it the composer needs the user.
const AUTO_CREATE_SETTLE_TIMEOUT_MS = 1500

/** Submits the composer once its defaults are ready; reports blocked when it can't or the create stays open. */
export function useComposerAutoCreate(
  onBlocked: (() => void) | undefined,
  ready: boolean,
  create: () => Promise<void>
): void {
  const enabled = onBlocked !== undefined
  const startedRef = useRef(false)
  const mountedRef = useRef(true)
  const onBlockedRef = useRef(onBlocked)
  onBlockedRef.current = onBlocked

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled || startedRef.current) {
      return
    }
    const timer = setTimeout(() => {
      if (!startedRef.current) {
        onBlockedRef.current?.()
      }
    }, AUTO_CREATE_SETTLE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [enabled])

  useEffect(() => {
    if (!enabled || !ready || startedRef.current) {
      return
    }
    startedRef.current = true
    // A successful create hands off and unmounts the composer; anything still mounted needs a choice.
    void create().finally(() => {
      if (mountedRef.current) {
        onBlockedRef.current?.()
      }
    })
  }, [enabled, ready, create])
}
