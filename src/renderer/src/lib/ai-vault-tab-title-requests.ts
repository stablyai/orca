import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import type { AiVaultSessionTitle } from '../../../shared/ai-vault-session-title'
import { isAiVaultTitleAgent } from '../../../shared/ai-vault-session-title'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { AgentPaneConversationIdentity } from '@/store/slices/agent-pane-conversation'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { getIndexedRepoMap, getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

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

type ConversationTab = TerminalTab & { worktreeId: string; leafIds?: ReadonlySet<string> }

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
  tabsById: ReadonlyMap<string, ConversationTab>,
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
  const worktreeId = tab?.worktreeId
  const pane = parsePaneKey(args.paneKey)
  if (
    !tabId ||
    !tab ||
    !worktreeId ||
    (pane && (pane.tabId !== tabId || (tab.leafIds && !tab.leafIds.has(pane.leafId)))) ||
    (args.worktreeId !== undefined && args.worktreeId !== worktreeId)
  ) {
    return
  }
  const priority = args.priority + (activePaneKey(state, tabId) === args.paneKey ? 100 : 0)
  const key = tabId
  if ((candidates.get(key)?.priority ?? -1) >= priority) {
    return
  }
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  candidates.set(key, {
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

function lastReportedCandidate(
  state: AppState,
  identity: AgentPaneConversationIdentity,
  tabsById: ReadonlyMap<string, ConversationTab>
): Parameters<typeof registerCandidate>[4] | null {
  const pane = parsePaneKey(identity.paneKey)
  const tab = pane ? tabsById.get(pane.tabId) : undefined
  const worktree = getIndexedWorktreeMap(selectWorktreesByRepo(state)).get(identity.worktreeId)
  const repo = worktree ? getIndexedRepoMap(state.repos).get(worktree.repoId) : undefined
  if (
    !pane ||
    tab?.worktreeId !== identity.worktreeId ||
    (tab.leafIds && !tab.leafIds.has(pane.leafId)) ||
    identity.executionHostId !== getExecutionHostIdForWorktree(state, identity.worktreeId) ||
    (repo !== undefined && identity.connectionId !== (repo.connectionId ?? null))
  ) {
    return null
  }
  return { ...identity, priority: 0, refresh: false }
}

function conversationRecords<T>(records: Record<string, T> | undefined, paneKey?: string): T[] {
  const addressed = paneKey ? records?.[paneKey] : undefined
  return paneKey ? (addressed ? [addressed] : []) : Object.values(records ?? {})
}

export function collectAiVaultTitleRequests(state: AppState): AiVaultTitleRequest[] {
  return collectAgentPaneConversations(state, isAiVaultTitleAgent).map(
    ({ paneKey: _paneKey, ...request }) => request
  )
}

/** Each tab's conversation: live, sleeping, retained, then its last reported identity. */
export function collectAgentPaneConversations<Agent extends AgentType>(
  state: AppState,
  isAgent: (agent: AgentType | null | undefined) => agent is Agent,
  options: {
    /** Skip retained and sleeping records: those remember a conversation after its agent exited. */
    runningAgentsOnly?: boolean
    includeLastReported?: boolean
    pane?: { worktreeId: string; paneKey: string }
    tab?: { worktreeId: string; tabId: string }
  } = {}
): AgentPaneConversation<Agent>[] {
  const addressed = options.pane
    ? {
        worktreeId: options.pane.worktreeId,
        tabId: tabIdFromPaneKey(
          options.pane.paneKey,
          state.agentStatusByPaneKey[options.pane.paneKey]?.tabId ??
            state.sleepingAgentSessionsByPaneKey[options.pane.paneKey]?.tabId ??
            state.retainedAgentsByPaneKey[options.pane.paneKey]?.entry.tabId
        )
      }
    : options.tab
  const partitions = addressed
    ? [
        [
          addressed.worktreeId,
          (state.tabsByWorktree[addressed.worktreeId] ?? []).filter(
            (tab) => tab.id === addressed.tabId
          )
        ] as const
      ]
    : Object.entries(state.tabsByWorktree)
  const tabsById = new Map<string, ConversationTab>()
  for (const [worktreeId, tabs] of partitions) {
    for (const tab of tabs) {
      const root = state.terminalLayoutsByTabId[tab.id]?.root
      tabsById.set(tab.id, {
        ...tab,
        worktreeId,
        ...(root ? { leafIds: new Set(collectLeafIdsInOrder(root)) } : {})
      })
    }
  }
  const records = <T>(record: Record<string, T> | undefined) =>
    conversationRecords(record, options.pane?.paneKey)
  const candidates = new Map<string, RequestCandidate<Agent>>()
  const retained = options.runningAgentsOnly ? [] : records(state.retainedAgentsByPaneKey)
  const sleeping = options.runningAgentsOnly ? [] : records(state.sleepingAgentSessionsByPaneKey)

  if (!options.runningAgentsOnly || options.includeLastReported) {
    for (const identity of records(state.agentConversationsByPaneKey)) {
      const candidate = lastReportedCandidate(state, identity, tabsById)
      if (candidate) {
        registerCandidate(state, tabsById, candidates, isAgent, candidate)
      }
    }
  }

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
  for (const entry of records(state.agentStatusByPaneKey)) {
    registerCandidate(state, tabsById, candidates, isAgent, liveCandidate(entry))
  }

  return [...candidates.values()]
    .filter((candidate) => !options.pane || candidate.paneKey === options.pane.paneKey)
    .map(({ priority: _priority, ...request }) => request)
}

export function resolvePaneAgentConversation<Agent extends AgentType>(
  state: AppState,
  pane: { worktreeId: string; paneKey: string },
  isAgent: (agent: AgentType | null | undefined) => agent is Agent
): AgentPaneConversation<Agent> | null {
  return collectAgentPaneConversations(state, isAgent, { pane, runningAgentsOnly: true })[0] ?? null
}

/** One pane's conversation survives occupancy cleanup after its agent exits. */
export function resolvePaneLastAgentConversation<Agent extends AgentType>(
  state: AppState,
  pane: { worktreeId: string; paneKey: string },
  isAgent: (agent: AgentType | null | undefined) => agent is Agent
): AgentPaneConversation<Agent> | null {
  return (
    collectAgentPaneConversations(state, isAgent, {
      pane,
      runningAgentsOnly: true,
      includeLastReported: true
    })[0] ?? null
  )
}
