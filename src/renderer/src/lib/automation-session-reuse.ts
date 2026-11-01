import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { AutomationRun } from '../../../shared/automations-types'
import {
  findReusableAutomationRun,
  type AutomationSessionTarget
} from '../../../shared/automation-session-reuse'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
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
  target: AutomationSessionTarget
  physicalTarget?: Pick<AutomationSessionTarget, 'hostId' | 'runtimeEnvironmentId'>
  currentRunId: string
  runs: AutomationRun[]
  state: Pick<
    AppState,
    'agentStatusByPaneKey' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'unifiedTabsByWorktree'
  >
}): ReusableAutomationSession | null {
  const { state, physicalTarget = args.target, ...selection } = args
  const terminalTabs = new Map(
    (state.unifiedTabsByWorktree[args.worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => [tab.entityId, tab])
  )
  return findReusableAutomationRun({
    ...selection,
    agentStatusForPane: (paneKey) => state.agentStatusByPaneKey[paneKey],
    liveSession: (run) => {
      const parsed = parsePaneKey(run.terminalPaneKey)
      const tab = parsed ? terminalTabs.get(parsed.tabId) : undefined
      const ptyHost = getPtyExecutionHost(run.terminalPtyId)
      if (
        !parsed ||
        !tab ||
        (tab.executionHostId && tab.executionHostId !== physicalTarget.hostId) ||
        ((ptyHost ?? 'local') !== physicalTarget.hostId &&
          !(
            physicalTarget.runtimeEnvironmentId &&
            ptyHost === toRuntimeExecutionHostId(physicalTarget.runtimeEnvironmentId) &&
            tab.executionHostId === physicalTarget.hostId
          )) ||
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
