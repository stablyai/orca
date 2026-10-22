import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useAppStore } from '@/store'

export function useStructuredChatSleepProjection(
  tab: { id: string; entityId: string },
  target: RuntimeClientTarget | null
): void {
  const feed = useMemo(
    () => (target ? getStructuredAgentSessionStatusFeed(target) : null),
    [target]
  )
  const sleptAt = useSyncExternalStore(
    feed?.subscribe ?? (() => () => {}),
    // An unidentified host keeps the workspace visible without guessing where its chat runs.
    () => (feed ? feed.getSessionSleepState(tab.entityId) : null),
    () => undefined
  )
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  useEffect(() => {
    const store = useAppStore.getState()
    if (sleptAt !== undefined) {
      store.setStructuredChatSleptAt(paneKey, sleptAt)
    }
  }, [paneKey, sleptAt, feed])
  useEffect(
    () => () => useAppStore.getState().setStructuredChatSleptAt(paneKey, undefined),
    [paneKey, feed]
  )
}
