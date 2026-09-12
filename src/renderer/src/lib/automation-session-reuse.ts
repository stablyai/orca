import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
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
  // Why: a status row proves what the agent is doing, but its absence proves
  // nothing — rows are dropped/aged independently of pane lifetime, so a
  // long-idle seed can outlive its row. Requiring one made reuse depend on the
  // agent having finished *recently*, which is backwards: the longer a pane sits
  // idle, the better a reuse target it is (#19193). Accept a missing row only
  // when this tab is a single-pane layout, so the run's leaf is provably the only
  // place the agent can be; in a split tab a sibling leaf may hold the agent and
  // submitting there would type into the wrong pane.
  const entry = state.agentStatusByPaneKey[run.terminalPaneKey]
  if (entry) {
    if (!isReusableAgentStatus(entry, agentId)) {
      return null
    }
  } else if (!isSoleLeafInTab(state, parsed.tabId, parsed.leafId)) {
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

// Why: without a status row, only a single-leaf tab proves the run's pane is the
// one holding the agent. A known layout must list this leaf and nothing else; an
// unknown layout is not proof, so it does not qualify.
function isSoleLeafInTab(
  state: Pick<AppState, 'terminalLayoutsByTabId'>,
  tabId: string,
  leafId: string
): boolean {
  const leafIds = Object.keys(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})
  return leafIds.length === 1 && leafIds[0] === leafId
}
