import type { AcceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { agentPaneConversationForEntry } from '@/store/slices/agent-status/agent-pane-conversation'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  promptsMatchSession,
  resolveOriginalPaneTarget,
  type OriginalPaneState,
  type AiVaultOriginalPaneTarget
} from './ai-vault-original-pane'

type LiveEntry = NonNullable<NonNullable<ReturnType<AcceptedAgentStatuses['get']>>>
type ConversationEntry = NonNullable<OriginalPaneState['agentConversationsByPaneKey'][string]>
type SleepingEntry = NonNullable<OriginalPaneState['sleepingAgentSessionsByPaneKey'][string]>

type ProviderIndex<T> = Map<string, T[]>
type AgentIndex<T> = Map<string, T[]>

export type AiVaultOriginalPaneIndex = {
  state: OriginalPaneState
  liveByProvider: ProviderIndex<LiveEntry>
  liveWithoutProviderByAgent: AgentIndex<LiveEntry>
  conversationsByProvider: ProviderIndex<ConversationEntry>
  conversationsWithoutProviderByAgent: AgentIndex<ConversationEntry>
  sleepingByProvider: ProviderIndex<SleepingEntry>
}

function providerKey(agent: string, sessionId: string): string {
  // NUL cannot collide with agent/session text, keeping identity pairs distinct.
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
  const conversationsByProvider: ProviderIndex<ConversationEntry> = new Map()
  const conversationsWithoutProviderByAgent: AgentIndex<ConversationEntry> = new Map()
  const sleepingByProvider: ProviderIndex<SleepingEntry> = new Map()

  for (const entry of Array.from(state.agentStatusByPaneKey.values())) {
    if (!entry?.agentType) {
      continue
    }
    if (entry.providerSession) {
      appendToIndex(liveByProvider, providerKey(entry.agentType, entry.providerSession.id), entry)
    } else if (entry.providerSession === undefined) {
      appendToIndex(liveWithoutProviderByAgent, entry.agentType, entry)
    }
  }
  for (const conversation of Object.values(state.agentConversationsByPaneKey)) {
    if (
      state.agentStatusByPaneKey.get(conversation.paneKey) ||
      !agentPaneConversationForEntry(state, { ...conversation, agentType: conversation.agent })
    ) {
      continue
    }
    if (conversation.providerSession) {
      appendToIndex(
        conversationsByProvider,
        providerKey(conversation.agent, conversation.providerSession.id),
        conversation
      )
    } else {
      appendToIndex(conversationsWithoutProviderByAgent, conversation.agent, conversation)
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
    conversationsByProvider,
    conversationsWithoutProviderByAgent,
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
  for (const conversation of index.conversationsByProvider.get(key) ?? []) {
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: conversation.paneKey,
      worktreeIdHint: conversation.worktreeId,
      tabIdHint: undefined
    })
    if (target) {
      return target
    }
  }
  for (const conversation of index.conversationsWithoutProviderByAgent.get(session.agent) ?? []) {
    if (!promptsMatchSession(session, conversation)) {
      continue
    }
    const target = resolveOriginalPaneTarget({
      state: index.state,
      paneKey: conversation.paneKey,
      worktreeIdHint: conversation.worktreeId,
      tabIdHint: undefined
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
): AgentDotState | null {
  const direct = index.liveByProvider.get(providerKey(session.agent, session.sessionId))
  if (direct?.[0]) {
    return agentRowDisplayDotState({ state: direct[0].state, entry: direct[0] })
  }
  const promptMatchedStates: AgentDotState[] = []
  for (const entry of index.liveWithoutProviderByAgent.get(session.agent) ?? []) {
    if (promptsMatchSession(session, entry)) {
      promptMatchedStates.push(agentRowDisplayDotState({ state: entry.state, entry }))
    }
  }
  return promptMatchedStates.length === 1 ? promptMatchedStates[0] : null
}
