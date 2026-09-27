import { useEffect } from 'react'
import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import { useAppStore } from '../store'
import { timeRendererStartupStep } from '../startup/startup-diagnostics'
import { localStructuredSessionsMayExist } from './local-structured-session-presence'
import { restoreLocalStructuredSessionTabsOnce } from './local-structured-session-tabs-sync/inventory-refresh'
import { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

export { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-publication-cursors'
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

/** Startup projection, skipped on a machine with neither Chat UI on nor a structured chat. */
export async function restoreLocalStructuredSessionTabsAtStartup(): Promise<void> {
  if (await localStructuredSessionsMayExist(useAppStore.getState().settings)) {
    await timeRendererStartupStep('project-structured-session-tabs', () =>
      restoreLocalStructuredSessionTabsOnce()
    )
  }
}

/** The one live sync for this renderer. Held as the subscription itself, not as a fact about it. */
let runningSync: { stop: () => void } | null = null

function ensureLocalStructuredSessionTabsSyncRunning(): void {
  if (runningSync) {
    return
  }
  let disposed = false
  let unsubscribe = (): void => {}
  const sync = {
    stop: () => {
      disposed = true
      unsubscribe()
      if (runningSync === sync) {
        runningSync = null
      }
    }
  }
  runningSync = sync
  void startLocalStructuredSessionTabsSync({
    isDisposed: () => disposed,
    setUnsubscribe: (next) => {
      unsubscribe = next
    }
  })
    .then((subscribed) => {
      // Disposed, or the host answered without the surface; released so a Chat UI change can ask again.
      if (!subscribed) {
        sync.stop()
      }
    })
    .catch((error) => {
      console.warn('[structured-session-tabs] sync failed', error)
      // Released so a later Chat UI change can try again.
      sync.stop()
    })
}

export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  const chatUiOn = useAppStore((state) => isNativeChatEnabled(state.settings))
  useEffect(() => {
    if (!ready || runningSync) {
      return
    }
    let cancelled = false
    // Starts once chats may exist; turning Chat UI off never stops it, since open chats stay.
    void localStructuredSessionsMayExist({ experimentalNativeChat: chatUiOn }).then((mayExist) => {
      if (mayExist && !cancelled) {
        ensureLocalStructuredSessionTabsSyncRunning()
      }
    })
    return () => {
      cancelled = true
    }
  }, [chatUiOn, ready])
  useEffect(() => () => runningSync?.stop(), [])
}
