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
  applyStructuredSessionTabSnapshots
} from './local-structured-session-tabs-sync/snapshot-apply'
export { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
export { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-projection'
export { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  // Not gated on Chat UI: that setting decides how new launches open, and chats already open stay.
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
