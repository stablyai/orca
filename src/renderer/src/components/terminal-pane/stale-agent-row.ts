import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { translate } from '@/i18n/i18n'

export function dismissStaleAgentRowByKey(paneKey: string): void {
  const store = useAppStore.getState()
  const liveExisted = paneKey in store.agentStatusByPaneKey
  const retainedExisted = paneKey in store.retainedAgentsByPaneKey
  store.dropAgentStatus(paneKey, { paneRemoved: true })
  store.dismissRetainedAgent(paneKey)
  if (liveExisted || retainedExisted) {
    showAgentPaneUnavailable(
      translate(
        'auto.components.terminal.pane.stale.agent.row.090d607412',
        'stale-agent-row-{{value0}}',
        { value0: paneKey }
      )
    )
  }
}

/** The one notice for a click that reaches an agent whose pane is gone. */
export function showAgentPaneUnavailable(id?: string): void {
  toast.info(
    translate(
      'auto.components.terminal.pane.stale.agent.row.ad991ece5c',
      "Agent's pane is no longer available."
    ),
    id === undefined ? undefined : { id }
  )
}

export function surfaceStaleAgentRow(tabId: string, leafId: string): void {
  dismissStaleAgentRowByKey(makePaneKey(tabId, leafId))
}
