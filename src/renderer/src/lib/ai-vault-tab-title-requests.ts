import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import type { AiVaultSessionTitle } from '../../../shared/ai-vault-session-title'
import { isAiVaultTitleAgent } from '../../../shared/ai-vault-session-title'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'

export type AgentPaneConversation<Agent extends AgentType> = {
  agent: Agent
  executionHostId: ExecutionHostId
  providerSession: AgentProviderSessionMetadata
  refresh: boolean
  tabId: string
  paneKey: string
  worktreeId: string
}

export type AiVaultTitleRequest = Omit<
  AgentPaneConversation<AiVaultSessionTitle['agent']>,
  'paneKey'
>

type RequestCandidate<Agent extends AgentType> = AgentPaneConversation<Agent> & {
  priority: number
}

function tabIdFromPaneKey(paneKey: string, tabId?: string): string | null {
  return tabId?.trim() || parsePaneKey(paneKey)?.tabId || null
}

function activePaneKey(state: AppState, tabId: string): string | null {
  const activeLeafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  return activeLeafId ? `${tabId}:${activeLeafId}` : null
}

function registerCandidate<Agent extends AgentType>(
  state: AppState,
  tabsById: ReadonlyMap<string, TerminalTab>,
  candidates: Map<string, RequestCandidate<Agent>>,
  isAgent: (agent: AgentType | null | undefined) => agent is Agent,
  args: {
    agent: AgentType | null | undefined
    paneKey: string
    priority: number
    providerSession: AgentProviderSessionMetadata | undefined
    refresh: boolean
    tabId?: string
    worktreeId?: string
  }
): void {
  if (!isAgent(args.agent) || !args.providerSession?.id) {
    return
  }
  const tabId = tabIdFromPaneKey(args.paneKey, args.tabId)
  const tab = tabId ? tabsById.get(tabId) : undefined
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
    paneKey: args.paneKey,
    worktreeId,
    priority
  })
}

function liveCandidate(entry: AgentStatusEntry): Parameters<typeof registerCandidate>[4] {
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

export function collectAiVaultTitleRequests(state: AppState): AiVaultTitleRequest[] {
  return collectAgentPaneConversations(state, isAiVaultTitleAgent).map(
    ({ paneKey: _paneKey, ...request }) => request
  )
}

export function collectAgentPaneConversations<Agent extends AgentType>(
  state: AppState,
  isAgent: (agent: AgentType | null | undefined) => agent is Agent,
  options: {
    /** Skip retained and sleeping records: those remember a conversation after its agent exited. */
    runningAgentsOnly?: boolean
  } = {}
): AgentPaneConversation<Agent>[] {
  const tabsById = new Map(
    Object.values(state.tabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab] as const)
  )
  const candidates = new Map<string, RequestCandidate<Agent>>()
  const retained = options.runningAgentsOnly ? [] : Object.values(state.retainedAgentsByPaneKey)
  const sleeping = options.runningAgentsOnly
    ? []
    : Object.values(state.sleepingAgentSessionsByPaneKey)

  for (const entry of retained) {
    registerCandidate(state, tabsById, candidates, isAgent, {
      agent: entry.agentType,
      paneKey: entry.entry.paneKey,
      priority: 10,
      providerSession: entry.entry.providerSession,
      refresh: false,
      tabId: entry.entry.tabId,
      worktreeId: entry.worktreeId
    })
  }
  for (const record of sleeping) {
    registerCandidate(state, tabsById, candidates, isAgent, {
      agent: record.agent,
      paneKey: record.paneKey,
      priority: 20,
      providerSession: record.providerSession,
      refresh: false,
      tabId: record.tabId,
      worktreeId: record.worktreeId
    })
  }
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    registerCandidate(state, tabsById, candidates, isAgent, liveCandidate(entry))
  }

  return [...candidates.values()].map(({ priority: _priority, ...request }) => request)
}

export function resolvePaneAgentConversation<Agent extends AgentType>(
  state: AppState,
  pane: { worktreeId: string; paneKey: string },
  isAgent: (agent: AgentType | null | undefined) => agent is Agent
): AgentPaneConversation<Agent> | null {
  const live = state.agentStatusByPaneKey[pane.paneKey]
  if (live?.paneKey !== pane.paneKey) {
    return null
  }
  const tabsById = new Map(
    (state.tabsByWorktree[pane.worktreeId] ?? []).map((tab) => [tab.id, tab] as const)
  )
  const candidates = new Map<string, RequestCandidate<Agent>>()
  registerCandidate(state, tabsById, candidates, isAgent, liveCandidate(live))
  const [candidate] = candidates.values()
  if (!candidate) {
    return null
  }
  const { priority: _priority, ...request } = candidate
  return request
}
