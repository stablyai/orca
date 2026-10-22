import type { AutomationRun } from '../../../shared/automations-types'
import { findReusableAutomationRun } from '../../../shared/automation-session-reuse'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AppState } from '@/store/types'

export type ReusableAutomationSession = {
  tabId: string
  ptyId: string
  paneKey: string
}

export function findReusableAutomationSession(args: {
  automationId: string
  agentId: TuiAgent
  worktreeId: string
  currentRunId: string
  runs: AutomationRun[]
  state: Pick<
    AppState,
    'agentStatusByPaneKey' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'unifiedTabsByWorktree'
  >
}): ReusableAutomationSession | null {
  const { state, ...selection } = args
  const terminalTabIds = new Set(
    (state.unifiedTabsByWorktree[args.worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => tab.entityId)
  )
  return findReusableAutomationRun({
    ...selection,
    agentStatusForPane: (paneKey) => state.agentStatusByPaneKey[paneKey],
    liveSession: (run) => {
      const parsed = parsePaneKey(run.terminalPaneKey)
      if (
        !parsed ||
        !terminalTabIds.has(parsed.tabId) ||
        !isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, run.terminalPtyId)
      ) {
        return null
      }
      return { tabId: parsed.tabId, ptyId: run.terminalPtyId, paneKey: run.terminalPaneKey }
    }
  })
}

function isRunPtyLiveInPane(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  if (!state.ptyIdsByTabId[tabId]?.includes(ptyId)) {
    return false
  }
  const layoutPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  return layoutPtyId === undefined || layoutPtyId === ptyId
}
