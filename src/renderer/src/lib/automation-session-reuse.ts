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
        run.terminalSessionId &&
        terminalTabIds.has(run.terminalSessionId)
    )
    .sort((left, right) => right.createdAt - left.createdAt)

  for (const run of candidates) {
    const tabId = run.terminalSessionId
    if (!tabId) {
      continue
    }
    const pane = findReusablePane(state.agentStatusByPaneKey, tabId, agentId)
    if (!pane) {
      continue
    }
    const ptyId = getReusablePanePtyId(state, tabId, pane.leafId)
    if (!ptyId) {
      continue
    }
    return { tabId, ptyId, paneKey: pane.paneKey }
  }
  return null
}

function findReusablePane(
  entries: Record<string, AgentStatusEntry>,
  tabId: string,
  agentId: TuiAgent
): { paneKey: string; leafId: string } | null {
  for (const [paneKey, entry] of Object.entries(entries)) {
    const parsed = parsePaneKey(paneKey)
    if (parsed?.tabId !== tabId || entry.state !== 'done') {
      continue
    }
    if (entry.agentType && entry.agentType !== 'unknown' && entry.agentType !== agentId) {
      continue
    }
    return { paneKey, leafId: parsed.leafId }
  }
  return null
}

function getReusablePanePtyId(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string,
  leafId: string
): string | null {
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId
  if (ptyIdsByLeafId && Object.keys(ptyIdsByLeafId).length > 0) {
    // Why: split terminal tabs can contain multiple PTYs; reuse must observe
    // the PTY assigned to the idle agent pane's stable leaf.
    return ptyIdsByLeafId[leafId] ?? null
  }
  return state.ptyIdsByTabId[tabId]?.[0] ?? null
}
