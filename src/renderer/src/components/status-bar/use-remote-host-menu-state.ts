import { useCallback, useEffect, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'

export type HostRecoveryObservation = { since: number; attempt: number }
export type HostMenuConnection = { id: string; recovering: boolean; attempt: number }

export function reconcileHostRecovery(
  previous: ReadonlyMap<string, HostRecoveryObservation>,
  hosts: HostMenuConnection[],
  now: number
): ReadonlyMap<string, HostRecoveryObservation> {
  const next = new Map<string, HostRecoveryObservation>()
  for (const host of hosts) {
    if (!host.recovering) {
      continue
    }
    const old = previous.get(host.id)
    next.set(
      host.id,
      old && old.attempt >= host.attempt
        ? old
        : {
            since: old?.since ?? now,
            attempt: Math.max(old?.attempt ?? 0, host.attempt)
          }
    )
  }
  return next.size === previous.size && [...next].every(([id, value]) => previous.get(id) === value)
    ? previous
    : next
}

export function useRemoteHostMenuState(open: boolean, hostExists: (id: string) => boolean) {
  const mounted = useMountedRef()
  const controllers = useRef(new Map<string, AbortController>())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [observations, setObservations] = useState<ReadonlyMap<string, HostRecoveryObservation>>(
    () => new Map()
  )
  const [now, setNow] = useState(0)
  const [deadlineTick, setDeadlineTick] = useState(0)
  const connect = useCallback(
    async (id: string, action: (signal: AbortSignal) => Promise<void>) => {
      if (controllers.current.has(id)) {
        return
      }
      const controller = new AbortController()
      controllers.current.set(id, controller)
      setPending(new Set(controllers.current.keys()))
      try {
        await action(controller.signal)
      } finally {
        if (controllers.current.get(id) === controller) {
          controllers.current.delete(id)
          if (mounted.current) {
            setPending(new Set(controllers.current.keys()))
          }
        }
      }
    },
    [mounted]
  )
  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort()
    controllers.current.delete(id)
    setPending(new Set(controllers.current.keys()))
  }, [])
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) {
        controller.abort()
      }
      controllers.current.clear()
    },
    []
  )
  useEffect(() => {
    if (!open) {
      return
    }
    const current = Date.now()
    setNow(current)
    let deadline = Infinity
    for (const observation of observations.values()) {
      if (observation.attempt < 3 && observation.since + 30_000 > current) {
        deadline = Math.min(deadline, observation.since + 30_000)
      }
    }
    if (!Number.isFinite(deadline)) {
      return
    }
    const timer = setTimeout(() => setDeadlineTick((tick) => tick + 1), deadline - current)
    return () => clearTimeout(timer)
  }, [open, observations, deadlineTick])
  useEffect(() => {
    let removed = false
    for (const [id, controller] of controllers.current) {
      if (!hostExists(id)) {
        controller.abort()
        controllers.current.delete(id)
        removed = true
      }
    }
    if (removed) {
      setPending(new Set(controllers.current.keys()))
    }
  }, [hostExists])
  const observe = (hosts: HostMenuConnection[]) => {
    // State equality makes this adjustment independent of array identity and dropdown lifetime.
    const next = reconcileHostRecovery(observations, hosts, 0)
    if (next !== observations) {
      setObservations((previous) => reconcileHostRecovery(previous, hosts, Date.now()))
    }
  }
  return { connect, cancel, pending, observations, now, observe }
}
