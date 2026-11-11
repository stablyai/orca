import { useEffect } from 'react'

export type ActiveVisibilityMutation = { kind: 'row'; path: string } | { kind: 'toggle' }

// Why: the modal unmounts on close, but its persistence request survives dismissal.
const activeMutations = new Map<string, ActiveVisibilityMutation>()
const mutationListeners = new Map<string, Set<() => void>>()

export function getActiveVisibilityMutation(scope: string): ActiveVisibilityMutation | undefined {
  return activeMutations.get(scope)
}

export function startVisibilityMutation(scope: string, mutation: ActiveVisibilityMutation): void {
  activeMutations.set(scope, mutation)
}

export function subscribeToVisibilityMutation(scope: string, listener: () => void): () => void {
  const listeners = mutationListeners.get(scope) ?? new Set()
  listeners.add(listener)
  mutationListeners.set(scope, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      mutationListeners.delete(scope)
    }
  }
}

export function finishVisibilityMutation(scope: string, mutation: ActiveVisibilityMutation): void {
  if (activeMutations.get(scope) !== mutation) {
    return
  }
  activeMutations.delete(scope)
  mutationListeners.get(scope)?.forEach((listener) => listener())
}

export function useVisibilityMutationFence(args: {
  scopes: string
  refresh: (scope: string) => Promise<boolean>
  reset: (scope: string, active: ActiveVisibilityMutation | undefined) => void
  settled: (scope: string, ready: boolean) => void
}): void {
  const { scopes, refresh, reset, settled } = args
  useEffect(() => {
    let cancelled = false
    const unsubscribes: (() => void)[] = []
    const parsed: unknown = JSON.parse(scopes)
    if (!Array.isArray(parsed)) {
      return
    }
    for (const scope of parsed) {
      if (typeof scope !== 'string') {
        continue
      }
      const active = getActiveVisibilityMutation(scope)
      reset(scope, active)
      if (!active) {
        continue
      }
      const unsubscribe = subscribeToVisibilityMutation(scope, () => {
        unsubscribe()
        void refresh(scope).then((ready) => {
          if (!cancelled && !getActiveVisibilityMutation(scope)) {
            settled(scope, ready)
          }
        })
      })
      unsubscribes.push(unsubscribe)
    }
    return () => {
      cancelled = true
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [scopes, refresh, reset, settled])
}
