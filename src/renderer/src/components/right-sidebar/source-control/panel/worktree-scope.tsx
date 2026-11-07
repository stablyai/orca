import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { create, type StoreApi } from 'zustand'
import { AppStateViewContext, useAppStateValue } from '@/store/app-state-view'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getConnectionId } from '@/lib/connection-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AttachedWorktreeOwner } from '../../folder-workspace-attached-worktrees'

export type SourceControlScope = AttachedWorktreeOwner & {
  repo: Repo
  placementWorkspaceId: string
}
/** Routing fields only, so worktree record churn (activity, unread, metadata) cannot refire scoped Git work. */
export type SourceControlScopeRouting = Pick<
  SourceControlScope,
  'worktreeId' | 'repoId' | 'executionHostId' | 'placementWorkspaceId'
> & {
  connectionId: string | null
  runtimeOwnerEnvironmentId: string | undefined
}
const WorktreeScope = createContext<SourceControlScopeRouting | null>(null)
const WorktreeScopeOwner = createContext<SourceControlScope | null>(null)
// Why default true: the selected workspace's panel has no section gate, as on main.
const SectionActive = createContext(true)
const mountedScopeCounts = new Map<string, number>()

/** Whether a folder section for this worktree is on screen, so its row actions can still apply. */
export function isSourceControlScopeMounted(worktreeId: string | null): boolean {
  return worktreeId !== null && mountedScopeCounts.has(worktreeId)
}
export function SourceControlScopeProvider({
  owner,
  active = true,
  children
}: {
  owner: SourceControlScope
  /** Expanded and on screen; inactive sections keep their view state but run no Git or review work. */
  active?: boolean
  children?: ReactNode
}) {
  // Hidden bodies retain their last snapshot and resume from current state when shown.
  const store = useMemo(() => {
    if (active) {
      return useAppStore
    }
    const snapshot = useAppStore.getState()
    return create<AppState>(() => snapshot)
  }, [active])
  const [visibleOwner, setVisibleOwner] = useState(owner)
  if (active && visibleOwner !== owner) {
    setVisibleOwner(owner)
  }
  const currentOwner = active ? owner : visibleOwner
  const { worktreeId, repoId, executionHostId, placementWorkspaceId } = currentOwner
  const connectionId = currentOwner.repo.connectionId ?? null
  const runtimeOwnerEnvironmentId = currentOwner.worktree.runtimeOwnerEnvironmentId
  const routing = useMemo(
    () => ({
      worktreeId,
      repoId,
      executionHostId,
      placementWorkspaceId,
      connectionId,
      runtimeOwnerEnvironmentId
    }),
    [
      worktreeId,
      repoId,
      executionHostId,
      placementWorkspaceId,
      connectionId,
      runtimeOwnerEnvironmentId
    ]
  )
  useEffect(() => {
    mountedScopeCounts.set(worktreeId, (mountedScopeCounts.get(worktreeId) ?? 0) + 1)
    return () => {
      const remaining = (mountedScopeCounts.get(worktreeId) ?? 1) - 1
      if (remaining > 0) {
        mountedScopeCounts.set(worktreeId, remaining)
      } else {
        mountedScopeCounts.delete(worktreeId)
      }
    }
  }, [worktreeId])
  return (
    <WorktreeScopeOwner.Provider value={currentOwner}>
      <WorktreeScope.Provider value={routing}>
        <SectionActive.Provider value={active}>
          <AppStateViewContext.Provider value={store}>{children}</AppStateViewContext.Provider>
        </SectionActive.Provider>
      </WorktreeScope.Provider>
    </WorktreeScopeOwner.Provider>
  )
}
export function useSourceControlScope(): SourceControlScopeRouting | null {
  return useContext(WorktreeScope)
}
/** Whether this panel may run Git/review work: always for the selected panel, expanded and on screen for a section. */
export function useSourceControlSectionActive(): boolean {
  return useContext(SectionActive)
}
/** The section's live worktree and repo records, for display state that must follow record updates. */
export function useSourceControlScopeOwner(): SourceControlScope | null {
  return useContext(WorktreeScopeOwner)
}

/** The section's runtime environment, falling back to a runtime execution host. */
export function sourceControlScopeRuntimeEnvironmentId(
  scope: SourceControlScopeRouting | null
): string | null | undefined {
  if (!scope) {
    return undefined
  }
  return (
    scope.runtimeOwnerEnvironmentId ??
    (scope.executionHostId.startsWith('runtime:')
      ? decodeURIComponent(scope.executionHostId.slice(8))
      : null)
  )
}

/** A folder section's repo connection for its own worktree; otherwise the selected copy's. An explicit owner connection wins. */
export function sourceControlConnectionId(
  scope: SourceControlScopeRouting | null,
  worktreeId: string | null,
  ownerConnectionId?: string | null
): string | undefined {
  if (ownerConnectionId !== undefined) {
    return ownerConnectionId ?? undefined
  }
  return (
    (scope?.worktreeId === worktreeId ? scope.connectionId : getConnectionId(worktreeId)) ??
    undefined
  )
}

/** Body context subscriptions stop while hidden; actions still read the live app store. */
export function useSourceControlState<T>(selector: (state: AppState) => T): T {
  return useAppStateValue(selector)
}

/** Pause a retained body's operation display without suspending the operation's owner. */
export function useSourceControlStoreView<T>(
  store: Pick<StoreApi<T>, 'getState' | 'getInitialState' | 'subscribe'>
) {
  const active = useSourceControlSectionActive()
  return useMemo(() => {
    if (active) {
      return store
    }
    const snapshot = store.getState()
    return { getState: () => snapshot, getInitialState: () => snapshot, subscribe: () => () => {} }
  }, [active, store])
}
