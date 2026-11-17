import { startRendererStatusPublication } from '../agent-status/renderer-status-publication'
import { useEffect } from 'react'
import { getSystemPrefersDarkSnapshot } from '../../hooks/theme/use-system-prefers-dark'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-key'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './graph-sync-scheduler'
import { useAppStore } from '../../store/index'
import { isPairedWebClientWindow } from '../../app-shell/chrome/desktop-window-chrome'

/** Keeps the mobile runtime graph republished as the store's session-visible state changes. */
export function useRuntimeGraphSync(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)

  useEffect(() => {
    setRuntimeGraphStoreStateGetter(useAppStore.getState)
    return () => {
      setRuntimeGraphStoreStateGetter(null)
    }
  }, [])

  useEffect(() => {
    let previousKey = getRuntimeMobileSessionSyncKey(useAppStore.getState())
    return useAppStore.subscribe((state, previousState) => {
      // Read cached dark-mode state; allocating matchMedia on every store mutation creates garbage.
      const systemPrefersDark = getSystemPrefersDarkSnapshot()
      // Skip key construction when every input reference is unchanged; mirror getRuntimeMobileSessionSyncKey’s fields.
      if (
        canSkipRuntimeMobileSessionSyncKeyBuild(
          state,
          previousState,
          systemPrefersDark,
          previousKey.systemPrefersDark
        )
      ) {
        return
      }
      const nextKey = getRuntimeMobileSessionSyncKey(
        state,
        previousState,
        previousKey,
        systemPrefersDark
      )
      if (runtimeMobileSessionSyncKeysEqual(nextKey, previousKey)) {
        return
      }
      previousKey = nextKey
      scheduleRuntimeGraphSync()
    })
  }, [])

  useEffect(
    () =>
      useAppStore.subscribe((state, previousState) => {
        // Publish project-catalog changes to paired phones.
        if (
          state.repos !== previousState.repos ||
          state.projects !== previousState.projects ||
          state.projectHostSetups !== previousState.projectHostSetups ||
          state.projectOrderBy !== previousState.projectOrderBy ||
          state.projectGroups !== previousState.projectGroups
        ) {
          scheduleRuntimeGraphSync()
        }
      }),
    []
  )

  useEffect(() => {
    // Why: a paired web client has no local main to publish status to.
    const stopStatusPublication =
      workspaceSessionReady && !isPairedWebClientWindow()
        ? startRendererStatusPublication(useAppStore, scheduleRuntimeGraphSync)
        : undefined
    setRuntimeGraphSyncEnabled(workspaceSessionReady)
    return () => {
      stopStatusPublication?.()
      setRuntimeGraphSyncEnabled(false)
    }
  }, [workspaceSessionReady])
}
