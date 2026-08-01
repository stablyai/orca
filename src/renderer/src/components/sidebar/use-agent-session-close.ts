import { useCallback, useState } from 'react'
import { parsePaneKey, parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import { closeDashboardAgentSession } from '@/components/dashboard/close-dashboard-agent-session'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'

/**
 * Confirmation state for closing an agent session from the sidebar. Live rows
 * confirm first — the whole terminal tab dies, splits and sibling agents
 * included. Retained rows have nothing to kill, so they never reach this.
 */
export function useAgentSessionClose(agents: DashboardAgentRowData[]): {
  closeTarget: DashboardAgentRowData | null
  requestClose: (paneKey: string) => void
  confirmClose: () => void
  cancelClose: () => void
} {
  const [closeTarget, setCloseTarget] = useState<DashboardAgentRowData | null>(null)
  const requestClose = useCallback(
    (paneKey: string) => {
      const row = agents.find((a) => a.paneKey === paneKey)
      if (row) {
        setCloseTarget(row)
      }
    },
    [agents]
  )
  const confirmClose = useCallback(() => {
    if (closeTarget) {
      const parsed =
        parsePaneKey(closeTarget.paneKey) ?? parseLegacyNumericPaneKey(closeTarget.paneKey)
      closeDashboardAgentSession({
        // Why: a malformed paneKey still resolves via the row's live tab id.
        tabId: parsed?.tabId ?? closeTarget.tab.id,
        paneKey: closeTarget.paneKey
      })
    }
    setCloseTarget(null)
  }, [closeTarget])
  const cancelClose = useCallback(() => setCloseTarget(null), [])
  return { closeTarget, requestClose, confirmClose, cancelClose }
}
