import { agentRowDotState, type AgentRowDotState } from '@/lib/agent-row-dot-state'
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

function providerKey(agent: string, sessionId: string): string {
  // Why: unlike punctuation delimiters, NUL cannot collide with agent or
  // provider-session text, so distinct identity pairs stay distinct keys.
  return `${agent}\u0000${sessionId}`
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
      appendToIndex(liveByProvider, providerKey(entry.agentType, entry.providerSession.id), entry)
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
        providerKey(retained.agentType, retained.entry.providerSession.id),
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
        providerKey(record.agent, record.providerSession.id),
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
): AgentRowDotState | null {
  const direct = index.liveByProvider.get(providerKey(session.agent, session.sessionId))
  if (direct?.[0]) {
    return agentRowDotState(direct[0].state, direct[0].workingMode, direct[0].interrupted)
  }
  const promptMatchedStates: AgentRowDotState[] = []
  for (const entry of index.liveWithoutProviderByAgent.get(session.agent) ?? []) {
    if (promptsMatchSession(session, entry)) {
      promptMatchedStates.push(agentRowDotState(entry.state, entry.workingMode, entry.interrupted))
    }
  }
  return promptMatchedStates.length === 1 ? promptMatchedStates[0] : null
}
