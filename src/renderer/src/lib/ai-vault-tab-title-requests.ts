import type {
  AgentProviderSessionMetadata,
  SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import type { AiVaultSessionTitle } from '../../../shared/ai-vault-session-title'
import { isAiVaultTitleAgent } from '../../../shared/ai-vault-session-title'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'

export type AiVaultTitleRequest = {
  agent: AiVaultSessionTitle['agent']
  executionHostId: ExecutionHostId
  providerSession: AgentProviderSessionMetadata
  refresh: boolean
  tabId: string
  worktreeId: string
}

type RequestCandidate = AiVaultTitleRequest & { priority: number }

function tabIdFromPaneKey(paneKey: string, tabId?: string): string | null {
  return tabId?.trim() || parsePaneKey(paneKey)?.tabId || null
}

function activePaneKey(state: AppState, tabId: string): string | null {
  const activeLeafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  return activeLeafId ? `${tabId}:${activeLeafId}` : null
}

type CandidateSource = {
  agent: AgentType | null | undefined
  paneKey: string
  priority: number
  providerSession: AgentProviderSessionMetadata | undefined
  refresh: boolean
  tabId?: string
  worktreeId?: string
}

// A pane's conversation sources, lowest priority first: retained, then sleeping, then live.
function retainedSource(entry: RetainedAgentEntry): CandidateSource {
  return {
    agent: entry.agentType,
    paneKey: entry.entry.paneKey,
    priority: 10,
    providerSession: entry.entry.providerSession,
    refresh: false,
    tabId: entry.entry.tabId,
    worktreeId: entry.worktreeId
  }
}

function sleepingSource(record: SleepingAgentSessionRecord): CandidateSource {
  return {
    agent: record.agent,
    paneKey: record.paneKey,
    priority: 20,
    providerSession: record.providerSession,
    refresh: false,
    tabId: record.tabId,
    worktreeId: record.worktreeId
  }
}

function liveSource(entry: AgentStatusEntry): CandidateSource {
  return {
    agent: entry.agentType,
    paneKey: entry.paneKey,
    priority: 30,
    providerSession: entry.providerSession,
    refresh: true,
    tabId: entry.tabId,
    worktreeId: entry.worktreeId
  }
}

function registerCandidate(
  state: AppState,
  findTab: (tabId: string) => TerminalTab | undefined,
  candidates: Map<string, RequestCandidate>,
  args: CandidateSource
): void {
  if (!isAiVaultTitleAgent(args.agent) || !args.providerSession?.id) {
    return
  }
  const tabId = tabIdFromPaneKey(args.paneKey, args.tabId)
  const tab = tabId ? findTab(tabId) : undefined
  const worktreeId = args.worktreeId ?? tab?.worktreeId
  if (!tabId || !tab || !worktreeId) {
    return
  }
  const priority = args.priority + (activePaneKey(state, tabId) === args.paneKey ? 100 : 0)
  if ((candidates.get(tabId)?.priority ?? -1) >= priority) {
    return
  }
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  candidates.set(tabId, {
    agent: args.agent,
    executionHostId,
    providerSession: args.providerSession,
    refresh: args.refresh,
    tabId,
    worktreeId,
    priority
  })
}

export function collectAiVaultTitleRequests(state: AppState): AiVaultTitleRequest[] {
  const tabsById = new Map(
    Object.values(state.tabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab] as const)
  )
  const candidates = new Map<string, RequestCandidate>()
  const sources = [
    ...Object.values(state.retainedAgentsByPaneKey).map(retainedSource),
    ...Object.values(state.sleepingAgentSessionsByPaneKey).map(sleepingSource),
    ...Object.values(state.agentStatusByPaneKey).map(liveSource)
  ]
  for (const source of sources) {
    registerCandidate(state, (tabId) => tabsById.get(tabId), candidates, source)
  }

  return [...candidates.values()].map(({ priority: _priority, ...request }) => request)
}

/** The same mapping narrowed to one pane, so a pane's action finds that pane's own conversation. */
export function resolvePaneAiVaultTitleRequest(
  state: AppState,
  pane: { worktreeId: string; paneKey: string }
): AiVaultTitleRequest | null {
  const retained = state.retainedAgentsByPaneKey[pane.paneKey]
  const sleeping = state.sleepingAgentSessionsByPaneKey[pane.paneKey]
  const live = state.agentStatusByPaneKey[pane.paneKey]
  const candidates = new Map<string, RequestCandidate>()
  const findTab = (tabId: string): TerminalTab | undefined =>
    state.tabsByWorktree[pane.worktreeId]?.find((tab) => tab.id === tabId)
  for (const source of [
    retained ? retainedSource(retained) : null,
    sleeping ? sleepingSource(sleeping) : null,
    live ? liveSource(live) : null
  ]) {
    if (source?.paneKey === pane.paneKey) {
      registerCandidate(state, findTab, candidates, source)
    }
  }
  const [candidate] = candidates.values()
  if (!candidate) {
    return null
  }
  const { priority: _priority, ...request } = candidate
  return request
}
