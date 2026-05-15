import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'

export function dismissStaleAgentRowByKey(paneKey: string): void {
  const store = useAppStore.getState()
  const liveExisted = paneKey in store.agentStatusByPaneKey
  const retainedExisted = paneKey in store.retainedAgentsByPaneKey
  store.dropAgentStatus(paneKey)
  store.dismissRetainedAgent(paneKey)
  if (liveExisted || retainedExisted) {
    toast.info("Agent's pane is no longer available.", {
      id: `stale-agent-row-${paneKey}`
    })
  }
}

export function surfaceStaleAgentRow(tabId: string, leafId: string): void {
  dismissStaleAgentRowByKey(makePaneKey(tabId, leafId))
}
