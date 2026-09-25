import { useEffect } from 'react'
import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import { useAppStore } from '../store'
import { timeRendererStartupStep } from '../startup/startup-diagnostics'
import { restoreLocalStructuredSessionTabsOnce } from './local-structured-session-tabs-sync/inventory-refresh'
import { clearLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-apply'
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
  removeLocalStructuredSessionTabs
} from './local-structured-session-tabs-sync/snapshot-apply'
export { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
export { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-projection'
export { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

/** Startup projection, skipped while Chat UI is off: the host serves no structured inventory then. */
export async function restoreLocalStructuredSessionTabsAtStartup(): Promise<void> {
  if (isNativeChatEnabled(useAppStore.getState().settings)) {
    await timeRendererStartupStep('project-structured-session-tabs', () =>
      restoreLocalStructuredSessionTabsOnce()
    )
  }
}

export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  useEffect(() => {
    if (!ready) {
      return
    }
    if (!enabled) {
      clearLocalStructuredSessionTabs()
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
  }, [enabled, ready])
}
