import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'

export type OrcaProfileSwitchLiveWorkState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'browserTabsByWorktree'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'tabsByWorktree'
>

export type OrcaProfileSwitchLiveWorkSummary = {
  hasLiveWork: boolean
  liveAgentCount: number
  livePtyCount: number
  liveTerminalTabCount: number
  browserWorkspaceCount: number
}

const LIVE_AGENT_STATES = new Set<AgentStatusEntry['state']>(['working', 'blocked', 'waiting'])

export function getOrcaProfileSwitchLiveWorkSummary(
  state: OrcaProfileSwitchLiveWorkState,
  now = Date.now()
): OrcaProfileSwitchLiveWorkSummary {
  const terminalSummary = getLiveTerminalSummary(state)
  const liveAgentCount = getLiveAgentKeys(state, now).size
  const browserWorkspaceCount = Object.values(state.browserTabsByWorktree).reduce(
    (count, workspaces) => count + workspaces.length,
    0
  )

  return {
    hasLiveWork:
      terminalSummary.livePtyCount > 0 || liveAgentCount > 0 || browserWorkspaceCount > 0,
    liveAgentCount,
    livePtyCount: terminalSummary.livePtyCount,
    liveTerminalTabCount: terminalSummary.liveTerminalTabCount,
    browserWorkspaceCount
  }
}

export function getOrcaProfileProjectLiveWorkSummary(
  state: OrcaProfileSwitchLiveWorkState,
  repoId: string,
  now = Date.now()
): OrcaProfileSwitchLiveWorkSummary {
  const tabsByWorktree = Object.fromEntries(
    Object.entries(state.tabsByWorktree).filter(([worktreeId]) =>
      worktreeBelongsToRepo(worktreeId, repoId)
    )
  )
  const tabIds = new Set(Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id)))
  const browserTabsByWorktree = Object.fromEntries(
    Object.entries(state.browserTabsByWorktree).filter(([worktreeId]) =>
      worktreeBelongsToRepo(worktreeId, repoId)
    )
  )
  const ptyIdsByTabId = Object.fromEntries(
    Object.entries(state.ptyIdsByTabId).filter(([tabId]) => tabIds.has(tabId))
  )
  const runtimePaneTitlesByTabId = Object.fromEntries(
    Object.entries(state.runtimePaneTitlesByTabId).filter(([tabId]) => tabIds.has(tabId))
  )
  const agentStatusByPaneKey = Object.fromEntries(
    Object.entries(state.agentStatusByPaneKey).filter(([paneKey, entry]) =>
      agentEntryBelongsToProject(paneKey, entry, repoId, tabIds)
    )
  )

  return getOrcaProfileSwitchLiveWorkSummary(
    {
      agentStatusByPaneKey,
      browserTabsByWorktree,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      tabsByWorktree
    },
    now
  )
}

function getLiveTerminalSummary(state: OrcaProfileSwitchLiveWorkState): {
  livePtyCount: number
  liveTerminalTabCount: number
} {
  const liveTabIds = new Set<string>()
  let livePtyCount = 0

  for (const [tabId, ptyIds] of Object.entries(state.ptyIdsByTabId)) {
    if (ptyIds.length === 0) {
      continue
    }
    livePtyCount += ptyIds.length
    liveTabIds.add(tabId)
  }

  return {
    livePtyCount,
    liveTerminalTabCount: liveTabIds.size
  }
}

function getLiveAgentKeys(state: OrcaProfileSwitchLiveWorkState, now: number): Set<string> {
  const keys = new Set<string>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (
      LIVE_AGENT_STATES.has(entry.state) &&
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    ) {
      keys.add(entry.paneKey)
    }
  }

  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      addTitleDetectedLiveAgentKeys(keys, state, tab)
    }
  }

  return keys
}

function addTitleDetectedLiveAgentKeys(
  keys: Set<string>,
  state: OrcaProfileSwitchLiveWorkState,
  tab: TerminalTab
): void {
  if (!tabHasLivePty(state.ptyIdsByTabId, tab.id)) {
    return
  }

  const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    for (const [paneId, title] of Object.entries(paneTitles)) {
      if (isLiveAgentTitle(title)) {
        keys.add(`${tab.id}:${paneId}`)
      }
    }
    return
  }

  if (isLiveAgentTitle(tab.title)) {
    keys.add(`${tab.id}:title`)
  }
}

function isLiveAgentTitle(title: string): boolean {
  const status = detectAgentStatusFromTitle(title)
  return status === 'working' || status === 'permission'
}

function agentEntryBelongsToProject(
  paneKey: string,
  entry: AgentStatusEntry,
  repoId: string,
  tabIds: Set<string>
): boolean {
  if (entry.worktreeId && worktreeBelongsToRepo(entry.worktreeId, repoId)) {
    return true
  }
  return tabIds.has(getPaneKeyTabId(paneKey))
}

function getPaneKeyTabId(paneKey: string): string {
  const separatorIndex = paneKey.lastIndexOf(':')
  return separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
}

function worktreeBelongsToRepo(worktreeId: string, repoId: string): boolean {
  return getRepoIdFromWorktreeId(worktreeId) === repoId
}
