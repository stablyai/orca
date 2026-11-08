import { useEffect } from 'react'
import { useAppStore } from '../../store/index'
import { startLocalStructuredSessionTabsSync } from './subscription'
import { useLocalStructuredChatsInUse } from '../native-chat/local-sessions/local-structured-chats'

/** Mirrors this machine's structured chats whenever they can exist, whatever the chat setting says:
 *  the setting picks what new agents open as, and chats that already exist keep showing. */
export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  const inUse = useLocalStructuredChatsInUse()
  useEffect(() => {
    if (!ready || !inUse) {
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
  }, [inUse, ready])
}
