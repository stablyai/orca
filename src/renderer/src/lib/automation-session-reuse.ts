import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
import type { TuiAgent } from '../../../shared/types'
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
  const { automationId, agentId, worktreeId, currentRunId, runs, state } = args
  const worktreeTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const terminalTabIds = new Set(
    worktreeTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
  )
  const candidates = runs
    .filter(
      (run) =>
        run.id !== currentRunId &&
        run.automationId === automationId &&
        run.workspaceId === worktreeId &&
        run.status === 'completed' &&
        Boolean(run.terminalPaneKey) &&
        Boolean(run.terminalPtyId)
    )
    .sort((left, right) => right.createdAt - left.createdAt)

  for (const run of candidates) {
    const exactPane = findReusableExactRunPane({ state, terminalTabIds, agentId, run })
    if (exactPane) {
      return exactPane
    }
  }
  return null
}

function findReusableExactRunPane({
  state,
  terminalTabIds,
  agentId,
  run
}: {
  state: Pick<AppState, 'agentStatusByPaneKey' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>
  terminalTabIds: Set<string>
  agentId: TuiAgent
  run: AutomationRun
}): ReusableAutomationSession | null {
  if (!run.terminalPaneKey || !run.terminalPtyId) {
    return null
  }
  const parsed = parsePaneKey(run.terminalPaneKey)
  if (!parsed || !terminalTabIds.has(parsed.tabId)) {
    return null
  }
  const entry = state.agentStatusByPaneKey[run.terminalPaneKey]
  if (!entry || !isReusableAgentStatus(entry, agentId)) {
    return null
  }
  if (!isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, run.terminalPtyId)) {
    return null
  }
  return { tabId: parsed.tabId, ptyId: run.terminalPtyId, paneKey: run.terminalPaneKey }
}

function isReusableAgentStatus(entry: AgentStatusEntry, agentId: TuiAgent): boolean {
  if (entry.state !== 'done') {
    return false
  }
  return !entry.agentType || entry.agentType === 'unknown' || entry.agentType === agentId
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
