import { useCallback, useEffect, useRef } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import {
  getAutomationHostTargetKey,
  getAutomationTargetFromHostId,
  listAutomationsForTarget
} from './automation-host-client'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { useSelectedAutomationRunHistory } from './use-selected-automation-run-history'
import type { AutomationsPageDestinationState } from './use-automations-page-destination-state'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Refreshes host-scoped rows and wires lifecycle/selection history effects. */
export function useAutomationsPageRefresh({
  store,
  local,
  list,
  destination
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  destination: AutomationsPageDestinationState
}) {
  const { fetchAllWorktrees, startupWorktreeRefreshCompleted, pendingAutomationRunNavigation } =
    store
  const {
    setIsLoading,
    setAutomations,
    setAutomationHostTargetKey,
    setFailedAuthorityKeys,
    isLoading,
    automationHostTargetKey,
    setRelativeNow,
    runHistoryReloadToken,
    workspaceNameCacheRef
  } = local
  const { scopedExternal, selectedRow } = list
  const { automationHostTargetFor } = destination
  const reloadExternalManagers = scopedExternal.reload

  const refresh = useCallback(
    async (options?: { awaitExternalManagers?: boolean }): Promise<void> => {
      setIsLoading(true)
      const pendingNavigation = useAppStore.getState().pendingAutomationRunNavigation
      // Until a navigation names a host, the desktop is the only authority the
      // legacy unscoped arm can address without guessing.
      const target = pendingNavigation
        ? getAutomationTargetFromHostId(pendingNavigation.hostId)
        : { kind: 'local' as const }
      const authorityKey = automationAuthorityCatalogKey(
        target.kind === 'environment'
          ? { kind: 'runtime', environmentId: target.environmentId }
          : { kind: 'desktop' }
      )
      const managersSettled = reloadExternalManagers().catch(() => undefined)
      try {
        const nextAutomations = await listAutomationsForTarget(target)
        setAutomations(nextAutomations)
        setAutomationHostTargetKey(getAutomationHostTargetKey(target))
        setFailedAuthorityKeys((current) => {
          if (!current.has(authorityKey)) {
            return current
          }
          const next = new Set(current)
          next.delete(authorityKey)
          return next
        })
      } catch {
        setFailedAuthorityKeys((current) => new Set(current).add(authorityKey))
      } finally {
        setIsLoading(false)
      }
      if (options?.awaitExternalManagers) {
        await managersSettled
      }
    },
    [
      reloadExternalManagers,
      setAutomations,
      setAutomationHostTargetKey,
      setFailedAuthorityKeys,
      setIsLoading
    ]
  )

  const hydratePersistedUIState = useCallback(async (): Promise<void> => {
    useAppStore.getState().hydratePersistedUI(await window.api.ui.get(), 'sync')
  }, [])

  const mountedBeforeStartupWorktreeRefreshRef = useRef(!startupWorktreeRefreshCompleted)
  useEffect(() => {
    if (!startupWorktreeRefreshCompleted) {
      return
    }
    if (mountedBeforeStartupWorktreeRefreshRef.current) {
      mountedBeforeStartupWorktreeRefreshRef.current = false
      return
    }
    void fetchAllWorktrees()
  }, [fetchAllWorktrees, startupWorktreeRefreshCompleted])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    return installWindowVisibilityInterval({
      run: () => setRelativeNow(Date.now()),
      intervalMs: 60 * 1000
    })
  }, [setRelativeNow])
  useEffect(() => {
    if (!pendingAutomationRunNavigation || isLoading) {
      return
    }
    const pendingTargetKey = getAutomationHostTargetKey(
      getAutomationTargetFromHostId(pendingAutomationRunNavigation.hostId)
    )
    if (automationHostTargetKey !== pendingTargetKey) {
      void refresh()
    }
  }, [automationHostTargetKey, isLoading, pendingAutomationRunNavigation, refresh])
  useEffect(() => {
    for (const [workspaceId, worktree] of store.worktreeMap) {
      const displayName = worktree.displayName.trim()
      if (displayName) {
        workspaceNameCacheRef.current.set(workspaceId, displayName)
      }
    }
  }, [store.worktreeMap, workspaceNameCacheRef])
  useSelectedAutomationRunHistory({
    selected: selectedRow,
    context: destination.automationDispatchContext,
    legacyTarget: automationHostTargetFor,
    navigation: pendingAutomationRunNavigation,
    reloadToken: runHistoryReloadToken,
    onSettled: local.setSelectedAutomationRuns
  })
  useEffect(() => {
    const onAutomationsChanged = (): void => {
      void refresh()
    }
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
    return () => window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
  }, [refresh])
  useEffect(() => {
    const onVisibilityOrFocus = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    window.addEventListener('focus', onVisibilityOrFocus)
    document.addEventListener('visibilitychange', onVisibilityOrFocus)
    return () => {
      window.removeEventListener('focus', onVisibilityOrFocus)
      document.removeEventListener('visibilitychange', onVisibilityOrFocus)
    }
  }, [refresh])

  return { getDefaultTarget: destination.getDefaultTarget, refresh, hydratePersistedUIState }
}

export type AutomationsPageRefresh = ReturnType<typeof useAutomationsPageRefresh>
