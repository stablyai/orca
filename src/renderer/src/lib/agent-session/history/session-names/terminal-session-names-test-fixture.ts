import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

export const WORKTREE_ID = 'wt-1'

export type FixtureTab = {
  id: string
  customTitle?: string | null
  /** The provider session running in the tab's only pane; omitted for a tab with no agent. */
  sessionId?: string
  agent?: AgentStatusEntry['agentType']
  title?: string
}

function leafId(tabId: string): string {
  return `00000000-0000-4000-8000-${tabId.padStart(12, '0').slice(-12)}`
}

function paneKey(tabId: string): string {
  return `${tabId}:${leafId(tabId)}`
}

function statusEntry(tab: FixtureTab, updatedAt = 1): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt,
    stateStartedAt: 1,
    agentType: tab.agent ?? 'claude',
    paneKey: paneKey(tab.id),
    tabId: tab.id,
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: tab.sessionId ?? '' },
    stateHistory: []
  }
}

function terminalTab(tab: FixtureTab, index: number): TerminalTab {
  return {
    id: tab.id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: tab.title ?? 'claude',
    customTitle: tab.customTitle ?? null,
    color: null,
    sortOrder: index,
    createdAt: index
  }
}

/** One local worktree whose tabs each run at most one agent session. */
export function makeTerminalNamesState(tabs: FixtureTab[]): AppState {
  const state: AppState = {
    ...useAppStore.getInitialState(),
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: 'local',
    agentStatusByPaneKey: acceptedAgentStatuses(
      tabs.filter((tab) => tab.sessionId).map((tab) => [paneKey(tab.id), statusEntry(tab)])
    ),
    sleepingAgentSessionsByPaneKey: {},
    agentConversationsByPaneKey: {},
    tabsByWorktree: { [WORKTREE_ID]: tabs.map(terminalTab) },
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: { type: 'leaf' as const, leafId: leafId(tab.id) },
          activeLeafId: leafId(tab.id),
          expandedLeafId: null
        }
      ])
    ),
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: (id: string) =>
      id === WORKTREE_ID ? makeWorktree({ id, repoId: 'repo-1', path: '/repo' }) : undefined
  }
  return state
}

/** The same state with each tab's status bumped, as an agent heartbeat does. */
export function withHeartbeat(state: AppState): AppState {
  const next = state.agentStatusByPaneKey.replace(
    Array.from(state.agentStatusByPaneKey.entries()).map(([key, entry]) => [
      key,
      { ...entry, updatedAt: entry.updatedAt + 1 }
    ])
  )
  next.prepare()()
  return { ...state, agentStatusByPaneKey: next }
}
