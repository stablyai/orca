import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { aiVaultProviderSessionKey } from '../../../../shared/ai-vault-session-display-title'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
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
}

function appendToIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
  const entries = index.get(key)
  if (entries) {
    entries.push(value)
  } else {
    index.set(key, [value])
  }
}

export function buildAiVaultOriginalPaneIndex(state: OriginalPaneState): AiVaultOriginalPaneIndex {
  const liveByProvider: ProviderIndex<LiveEntry> = new Map()
  const liveWithoutProviderByAgent: AgentIndex<LiveEntry> = new Map()
  const retainedByProvider: ProviderIndex<RetainedEntry> = new Map()
  const retainedWithoutProviderByAgent: AgentIndex<RetainedEntry> = new Map()
  const sleepingByProvider: ProviderIndex<SleepingEntry> = new Map()

  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (!entry?.agentType) {
      continue
    }
    if (entry.providerSession) {
      appendToIndex(
        liveByProvider,
        aiVaultProviderSessionKey(entry.agentType, entry.providerSession.id),
        entry
      )
    } else if (entry.providerSession === undefined) {
      appendToIndex(liveWithoutProviderByAgent, entry.agentType, entry)
    }
  }
  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (!retained?.agentType) {
      continue
    }
    if (retained.entry.providerSession) {
      appendToIndex(
        retainedByProvider,
        aiVaultProviderSessionKey(retained.agentType, retained.entry.providerSession.id),
        retained
      )
    } else if (retained.entry.providerSession === undefined) {
      appendToIndex(retainedWithoutProviderByAgent, retained.agentType, retained)
    }
  }
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record) {
      appendToIndex(
        sleepingByProvider,
        aiVaultProviderSessionKey(record.agent, record.providerSession.id),
        record
      )
    }
  }

  return {
    state,
    liveByProvider,
    liveWithoutProviderByAgent,
    retainedByProvider,
    retainedWithoutProviderByAgent,
    sleepingByProvider
  }
}

export function createLazyAiVaultOriginalPaneIndex(
  state: OriginalPaneState
): () => AiVaultOriginalPaneIndex {
  let index: AiVaultOriginalPaneIndex | null = null
  return () => {
    index ??= buildAiVaultOriginalPaneIndex(state)
    return index
  }
}

export function findOriginalAiVaultSessionPaneInIndex(
  index: AiVaultOriginalPaneIndex,
  session: AiVaultSession
): AiVaultOriginalPaneTarget | null {
  const key = aiVaultProviderSessionKey(session.agent, session.sessionId)
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
  const direct = index.liveByProvider.get(
    aiVaultProviderSessionKey(session.agent, session.sessionId)
  )
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
