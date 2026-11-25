import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'

let exemptWorktreeId: string | null = null
const listeners = new Set<() => void>()
let unsubscribeStore: (() => void) | null = null

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function stopStoreSubscription(): void {
  if (unsubscribeStore) {
    unsubscribeStore()
    unsubscribeStore = null
  }
}

function isWorktreeStillActive(
  state: Pick<ReturnType<typeof useAppStore.getState>, 'activeWorkspaceKey' | 'activeWorktreeId'>,
  worktreeId: string
): boolean {
  return (
    state.activeWorktreeId === worktreeId &&
    getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId) === worktreeId
  )
}

function ensureStoreSubscription(): void {
  if (unsubscribeStore || exemptWorktreeId === null) {
    return
  }
  unsubscribeStore = useAppStore.subscribe((state) => {
    if (exemptWorktreeId !== null && !isWorktreeStillActive(state, exemptWorktreeId)) {
      exemptWorktreeId = null
      stopStoreSubscription()
      notifyListeners()
    }
  })
}

export function getActiveFilterExemptWorktreeId(): string | null {
  if (exemptWorktreeId === null) {
    return null
  }
  if (!isWorktreeStillActive(useAppStore.getState(), exemptWorktreeId)) {
    exemptWorktreeId = null
    stopStoreSubscription()
    return null
  }
  return exemptWorktreeId
}

/** Keeps a jumped-to worktree visible under non-lifted sidebar filters until active selection leaves it. */
export function markWorktreeFilterExemptWhileActive(worktreeId: string | null): void {
  if (exemptWorktreeId === worktreeId) {
    if (worktreeId !== null) {
      ensureStoreSubscription()
    }
    return
  }
  exemptWorktreeId = worktreeId
  if (worktreeId === null) {
    stopStoreSubscription()
  } else {
    ensureStoreSubscription()
  }
  notifyListeners()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useActiveFilterExemptWorktreeId(): string | null {
  return useSyncExternalStore(subscribe, getActiveFilterExemptWorktreeId)
}

export function mergeForcedVisibleWorktreeIds(
  agentSendTargetWorktreeId: string | null | undefined,
  activeExemptWorktreeId: string | null | undefined
): string[] | undefined {
  if (!agentSendTargetWorktreeId && !activeExemptWorktreeId) {
    return undefined
  }
  if (!agentSendTargetWorktreeId) {
    return [activeExemptWorktreeId!]
  }
  if (!activeExemptWorktreeId || agentSendTargetWorktreeId === activeExemptWorktreeId) {
    return [agentSendTargetWorktreeId]
  }
  return [agentSendTargetWorktreeId, activeExemptWorktreeId]
}

export function useForcedVisibleWorktreeIds(
  agentSendTargetWorktreeId: string | null | undefined
): string[] | undefined {
  const activeFilterExemptWorktreeId = useActiveFilterExemptWorktreeId()
  return useMemo(
    () => mergeForcedVisibleWorktreeIds(agentSendTargetWorktreeId, activeFilterExemptWorktreeId),
    [agentSendTargetWorktreeId, activeFilterExemptWorktreeId]
  )
}
