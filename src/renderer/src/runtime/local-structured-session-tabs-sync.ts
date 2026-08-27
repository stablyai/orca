import { useEffect } from 'react'
import { useAppStore } from '../store'
import { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

export {
  isCurrentLocalStructuredSessionGeneration,
  localStructuredSessionGeneration,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync/inventory-generation-fence'
export {
  refreshLocalStructuredSessionTabs,
  restoreLocalStructuredSessionTabsOnce
} from './local-structured-session-tabs-sync/inventory-refresh'
export {
  applyLocalStructuredSessionTabSnapshots,
  applyStructuredSessionTabSnapshots,
  clearLocalStructuredSessionTabs,
  LOCAL_STRUCTURED_SESSION_OWNER,
  removeLocalStructuredSessionTabs
} from './local-structured-session-tabs-sync/snapshot-apply'
export { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-projection'
export { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  useEffect(() => {
    if (!ready) {
      return
    }
    let disposed = false
    let unsubscribe = (): void => {}
    void startLocalStructuredSessionTabsSync({
      isDisposed: () => disposed,
      setUnsubscribe: (next) => {
        unsubscribe = next
      }
    }).catch((error) => console.warn('[structured-session-tabs] sync failed', error))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [ready])
}
