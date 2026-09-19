import type { AgentStatusState } from '../../../../shared/agent-status-types'
import {
  aiVaultProviderSessionKey,
  resolveAiVaultSessionDisplayTitle
} from '../../../../shared/ai-vault-session-display-title'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  promptsMatchSession,
  resolveOriginalPaneTarget,
  type OriginalPaneState,
  type AiVaultOriginalPaneTarget
} from './ai-vault-original-pane'

type LiveEntry = NonNullable<OriginalPaneState['agentStatusByPaneKey'][string]>
type RetainedEntry = NonNullable<OriginalPaneState['retainedAgentsByPaneKey'][string]>
type SleepingEntry = NonNullable<OriginalPaneState['sleepingAgentSessionsByPaneKey'][string]>

type ProviderIndex<T> = Map<string, T[]>
type AgentIndex<T> = Map<string, T[]>

export type AiVaultOriginalPaneIndex = {
  state: OriginalPaneState
  liveByProvider: ProviderIndex<LiveEntry>
  liveWithoutProviderByAgent: AgentIndex<LiveEntry>
  retainedByProvider: ProviderIndex<RetainedEntry>
  retainedWithoutProviderByAgent: AgentIndex<RetainedEntry>
  sleepingByProvider: ProviderIndex<SleepingEntry>
  customTitleByProvider: Map<string, string>
}

function providerKey(agent: string, sessionId: string): string {
  return aiVaultProviderSessionKey(agent, sessionId)
}

function paneTabId(tabId: string | undefined, paneKey: string): string | undefined {
  return tabId?.trim() || parsePaneKey(paneKey)?.tabId
}

function appendToIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
  const entries = index.get(key)
  if (entries) {
    entries.push(value)
  } else {
    index.set(key, [value])
  }
}

/** Index live/retained/sleeping panes and their current Orca custom titles. */
export function buildAiVaultOriginalPaneIndex(state: OriginalPaneState): AiVaultOriginalPaneIndex {
  const liveByProvider: ProviderIndex<LiveEntry> = new Map()
  const liveWithoutProviderByAgent: AgentIndex<LiveEntry> = new Map()
  const retainedByProvider: ProviderIndex<RetainedEntry> = new Map()
  const retainedWithoutProviderByAgent: AgentIndex<RetainedEntry> = new Map()
  const sleepingByProvider: ProviderIndex<SleepingEntry> = new Map()
  const customTitleByProvider = new Map<string, string>()
  const liveClaimed = new Set<string>()
  const retainedClaimed = new Set<string>()
  const tabsById = new Map(
    Object.values(state.tabsByWorktree).flatMap((tabs) =>
      (tabs ?? []).map((tab) => [tab.id, tab] as const)
    )
  )

  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (!entry?.agentType) {
      continue
    }
    if (entry.providerSession) {
      const key = providerKey(entry.agentType, entry.providerSession.id)
      appendToIndex(liveByProvider, key, entry)
      const tabId = paneTabId(entry.tabId, entry.paneKey)
      const tab = tabId ? tabsById.get(tabId) : undefined
      if (tab) {
        liveClaimed.add(key)
        const title = tab.customTitle?.trim()
        if (title && !customTitleByProvider.has(key)) {
          customTitleByProvider.set(key, title)
        }
      }
    } else if (entry.providerSession === undefined) {
      appendToIndex(liveWithoutProviderByAgent, entry.agentType, entry)
    }
  }
  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (!retained?.agentType) {
      continue
    }
    if (retained.entry.providerSession) {
      const key = providerKey(retained.agentType, retained.entry.providerSession.id)
      appendToIndex(retainedByProvider, key, retained)
      if (!liveClaimed.has(key)) {
        retainedClaimed.add(key)
        // Prefer the live tab object when it still exists — retained.tab is a
        // disappearance-time snapshot and will miss later renames/clears.
        const tabId = paneTabId(retained.entry.tabId ?? retained.tab.id, retained.entry.paneKey)
        const currentTab = tabId ? tabsById.get(tabId) : undefined
        const title = currentTab
          ? currentTab.customTitle?.trim() || undefined
          : retained.tab.customTitle?.trim() || undefined
        if (title && !customTitleByProvider.has(key)) {
          customTitleByProvider.set(key, title)
        }
      }
    } else if (retained.entry.providerSession === undefined) {
      appendToIndex(retainedWithoutProviderByAgent, retained.agentType, retained)
    }
  }
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record) {
      const key = providerKey(record.agent, record.providerSession.id)
      appendToIndex(sleepingByProvider, key, record)
      if (liveClaimed.has(key) || retainedClaimed.has(key)) {
        continue
      }
      const tabId = paneTabId(record.tabId, record.paneKey)
      const title = (tabId ? tabsById.get(tabId)?.customTitle : null)?.trim()
      if (title && !customTitleByProvider.has(key)) {
        customTitleByProvider.set(key, title)
      }
    }
  }

  return {
    state,
    liveByProvider,
    liveWithoutProviderByAgent,
    retainedByProvider,
    retainedWithoutProviderByAgent,
    sleepingByProvider,
    customTitleByProvider
  }
}

let sharedIndex: { state: OriginalPaneState; index: AiVaultOriginalPaneIndex } | null = null

export function getSharedAiVaultOriginalPaneIndex(
  state: OriginalPaneState
): AiVaultOriginalPaneIndex {
  if (
    sharedIndex &&
    sharedIndex.state.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    sharedIndex.state.retainedAgentsByPaneKey === state.retainedAgentsByPaneKey &&
    sharedIndex.state.sleepingAgentSessionsByPaneKey === state.sleepingAgentSessionsByPaneKey &&
    sharedIndex.state.tabsByWorktree === state.tabsByWorktree &&
    sharedIndex.state.terminalLayoutsByTabId === state.terminalLayoutsByTabId
  ) {
    return sharedIndex.index
  }
  const index = buildAiVaultOriginalPaneIndex(state)
  sharedIndex = { state, index }
  return index
}

export function createLazyAiVaultOriginalPaneIndex(
  state: OriginalPaneState
): () => AiVaultOriginalPaneIndex {
  return () => getSharedAiVaultOriginalPaneIndex(state)
}

export function findOriginalAiVaultSessionPaneInIndex(
  index: AiVaultOriginalPaneIndex,
  session: AiVaultSession
): AiVaultOriginalPaneTarget | null {
  const key = providerKey(session.agent, session.sessionId)
  const promptMatchedTargets: AiVaultOriginalPaneTarget[] = []

  for (const entry of index.liveByProvider.get(key) ?? []) {
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: entry.paneKey,
      worktreeIdHint: entry.worktreeId,
      tabIdHint: entry.tabId
    })
    if (target) {
      return target
    }
  }
  for (const entry of index.liveWithoutProviderByAgent.get(session.agent) ?? []) {
    if (!promptsMatchSession(session, entry)) {
      continue
    }
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: entry.paneKey,
      worktreeIdHint: entry.worktreeId,
      tabIdHint: entry.tabId
    })
    if (target) {
      promptMatchedTargets.push(target)
    }
  }
  for (const retained of index.retainedByProvider.get(key) ?? []) {
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: retained.entry.paneKey,
      worktreeIdHint: retained.worktreeId,
      tabIdHint: retained.entry.tabId ?? retained.tab.id
    })
    if (target) {
      return target
    }
  }
  for (const retained of index.retainedWithoutProviderByAgent.get(session.agent) ?? []) {
    if (!promptsMatchSession(session, retained.entry)) {
      continue
    }
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: retained.entry.paneKey,
      worktreeIdHint: retained.worktreeId,
      tabIdHint: retained.entry.tabId ?? retained.tab.id
    })
    if (target) {
      promptMatchedTargets.push(target)
    }
  }
  for (const record of index.sleepingByProvider.get(key) ?? []) {
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: record.paneKey,
      worktreeIdHint: record.worktreeId,
      tabIdHint: record.tabId
    })
    if (target) {
      return target
    }
  }

  return promptMatchedTargets.length === 1 ? promptMatchedTargets[0] : null
}

export function findAiVaultSessionLiveStateInIndex(
  index: AiVaultOriginalPaneIndex,
  session: AiVaultSession
): AgentStatusState | null {
  const direct = index.liveByProvider.get(providerKey(session.agent, session.sessionId))
  if (direct?.[0]) {
    return direct[0].state
  }
  const promptMatchedStates: AgentStatusState[] = []
  for (const entry of index.liveWithoutProviderByAgent.get(session.agent) ?? []) {
    if (promptsMatchSession(session, entry)) {
      promptMatchedStates.push(entry.state)
    }
  }
  return promptMatchedStates.length === 1 ? promptMatchedStates[0] : null
}

/** Orca tab rename for a vault session, or null when none / subagent. */
export function findAiVaultSessionCustomTitle(
  index: AiVaultOriginalPaneIndex,
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'subagent'>
): string | null {
  if (session.subagent) {
    return null
  }
  return index.customTitleByProvider.get(providerKey(session.agent, session.sessionId)) ?? null
}

/** List-row title: Orca rename wins over the scanner title (not for subagents). */
export function resolveAiVaultSessionListTitle(
  index: AiVaultOriginalPaneIndex,
  session: AiVaultSession
): string {
  return resolveAiVaultSessionDisplayTitle(session, findAiVaultSessionCustomTitle(index, session))
}
