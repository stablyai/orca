import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

export type ActiveVisibilityMutation = { kind: 'row'; path: string } | { kind: 'toggle' }
type VisibilityListState = 'checking' | 'ready' | 'failed'

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

export function useVisibilityMutationFence<T>(args: {
  scope: string
  repoId: string
  currentScopeRef: MutableRefObject<string>
  refresh: (repoId: string, options: { requireAuthoritative: true }) => Promise<boolean>
  setActionState: Dispatch<SetStateAction<T | null>>
  setBusyPath: Dispatch<SetStateAction<string | null>>
  setIsToggling: Dispatch<SetStateAction<boolean>>
  setListState: Dispatch<SetStateAction<VisibilityListState>>
}): void {
  const {
    currentScopeRef,
    refresh,
    repoId,
    scope,
    setActionState,
    setBusyPath,
    setIsToggling,
    setListState
  } = args
  useEffect(() => {
    const activeMutation = getActiveVisibilityMutation(scope)
    setActionState(null)
    setBusyPath(activeMutation?.kind === 'row' ? activeMutation.path : null)
    setIsToggling(activeMutation?.kind === 'toggle')
    if (!activeMutation) {
      return
    }
    let cancelled = false
    let unsubscribe = (): void => undefined
    unsubscribe = subscribeToVisibilityMutation(scope, () => {
      unsubscribe()
      void refresh(repoId, { requireAuthoritative: true }).then((refreshed) => {
        if (!cancelled && currentScopeRef.current === scope) {
          setListState(refreshed ? 'ready' : 'failed')
          setBusyPath(null)
          setIsToggling(false)
        }
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [
    currentScopeRef,
    refresh,
    repoId,
    scope,
    setActionState,
    setBusyPath,
    setIsToggling,
    setListState
  ])
}
