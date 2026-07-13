import type { AppState } from '@/store/types'
import { resolveRuntimePaneTitleLeafId } from '@/lib/runtime-pane-title-leaf-id'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'

export type AiVaultOriginalPaneTarget = {
  paneKey: string
  worktreeId: string
  tabId: string
  leafId: string
}

export type OriginalPaneState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>

function agentMatches(session: AiVaultSession, agent: string | undefined): boolean {
  return agent === session.agent
}

function providerSessionMatches(session: AiVaultSession, providerSessionId: string | undefined) {
  return providerSessionId === session.sessionId
}

function normalizeMatchText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? ''
}

function longEnoughForPrefixMatch(value: string): boolean {
  return value.length >= 24
}

function textMatchesSessionPrompt(sessionText: string, candidateText: string): boolean {
  if (!sessionText || !candidateText) {
    return false
  }
  if (sessionText === candidateText) {
    return true
  }
  return (
    longEnoughForPrefixMatch(sessionText) &&
    longEnoughForPrefixMatch(candidateText) &&
    (sessionText.startsWith(candidateText) || candidateText.startsWith(sessionText))
  )
}

function sessionPromptCandidates(session: AiVaultSession): string[] {
  const candidates = new Set<string>()
  const title = normalizeMatchText(session.title)
  if (title) {
    candidates.add(title)
  }
  for (const message of session.previewMessages) {
    if (message.role !== 'user') {
      continue
    }
    const text = normalizeMatchText(message.text)
    if (text) {
      candidates.add(text)
    }
  }
  return [...candidates]
}

function entryPromptCandidates(entry: {
  prompt?: string
  stateHistory?: readonly { prompt: string }[]
}): string[] {
  const candidates = new Set<string>()
  const prompt = normalizeMatchText(entry.prompt)
  if (prompt) {
    candidates.add(prompt)
  }
  for (const historyEntry of entry.stateHistory ?? []) {
    const text = normalizeMatchText(historyEntry.prompt)
    if (text) {
      candidates.add(text)
    }
  }
  return [...candidates]
}

export function promptsMatchSession(
  session: AiVaultSession,
  entry: Parameters<typeof entryPromptCandidates>[0]
): boolean {
  const sessionCandidates = sessionPromptCandidates(session)
  if (sessionCandidates.length === 0) {
    return false
  }
  const entryCandidates = entryPromptCandidates(entry)
  return sessionCandidates.some((sessionText) =>
    entryCandidates.some((entryText) => textMatchesSessionPrompt(sessionText, entryText))
  )
}

function layoutHasLeaf(node: TerminalPaneLayoutNode | null | undefined, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutHasLeaf(node.first, leafId) || layoutHasLeaf(node.second, leafId)
}

function hasAvailableLeaf(layout: TerminalLayoutSnapshot | undefined, leafId: string): boolean {
  return layoutHasLeaf(layout?.root, leafId) || Boolean(layout?.ptyIdsByLeafId?.[leafId])
}

function getTabOwnerWorktreeId(
  state: OriginalPaneState,
  tabId: string,
  worktreeIdHint?: string
): string | null {
  if (
    worktreeIdHint &&
    (state.tabsByWorktree[worktreeIdHint] ?? []).some((tab) => tab.id === tabId)
  ) {
    return worktreeIdHint
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

export function resolveOriginalPaneTarget(args: {
  state: OriginalPaneState
  paneKey: string
  worktreeIdHint?: string
  tabIdHint?: string
}): AiVaultOriginalPaneTarget | null {
  const { state, paneKey, worktreeIdHint, tabIdHint } = args
  const stable = parsePaneKey(paneKey)
  if (stable) {
    if (tabIdHint && tabIdHint !== stable.tabId) {
      return null
    }
    const worktreeId = getTabOwnerWorktreeId(state, stable.tabId, worktreeIdHint)
    if (
      !worktreeId ||
      !hasAvailableLeaf(state.terminalLayoutsByTabId[stable.tabId], stable.leafId)
    ) {
      return null
    }
    return { paneKey, worktreeId, tabId: stable.tabId, leafId: stable.leafId }
  }

  const legacy = parseLegacyNumericPaneKey(paneKey)
  if (!legacy || (tabIdHint && tabIdHint !== legacy.tabId)) {
    return null
  }
  const worktreeId = getTabOwnerWorktreeId(state, legacy.tabId, worktreeIdHint)
  if (!worktreeId) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[legacy.tabId]
  const leafId = resolveRuntimePaneTitleLeafId(layout, legacy.numericPaneId)
  if (!leafId || !hasAvailableLeaf(layout, leafId)) {
    return null
  }
  return { paneKey, worktreeId, tabId: legacy.tabId, leafId }
}

/**
 * The hook-reported live state of the agent currently running this session,
 * or null when the session is not live in any pane. Matches by provider
 * session id first; falls back to a prompt match only when it is unambiguous.
 */
export function findAiVaultSessionLiveState(
  state: Pick<AppState, 'agentStatusByPaneKey'>,
  session: AiVaultSession
): AgentStatusState | null {
  const promptMatchedStates: AgentStatusState[] = []

  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (!agentMatches(session, entry.agentType)) {
      continue
    }
    if (providerSessionMatches(session, entry.providerSession?.id)) {
      return entry.state
    }
    if (entry.providerSession === undefined && promptsMatchSession(session, entry)) {
      promptMatchedStates.push(entry.state)
    }
  }

  return promptMatchedStates.length === 1 ? promptMatchedStates[0] : null
}

export function findOriginalAiVaultSessionPane(
  state: OriginalPaneState,
  session: AiVaultSession
): AiVaultOriginalPaneTarget | null {
  const promptMatchedTargets: AiVaultOriginalPaneTarget[] = []

  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (
      agentMatches(session, entry.agentType) &&
      providerSessionMatches(session, entry.providerSession?.id)
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: entry.paneKey,
        worktreeIdHint: entry.worktreeId,
        tabIdHint: entry.tabId
      })
      if (target) {
        return target
      }
    }
    if (
      agentMatches(session, entry.agentType) &&
      entry.providerSession === undefined &&
      promptsMatchSession(session, entry)
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: entry.paneKey,
        worktreeIdHint: entry.worktreeId,
        tabIdHint: entry.tabId
      })
      if (target) {
        promptMatchedTargets.push(target)
      }
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (
      agentMatches(session, retained.agentType) &&
      providerSessionMatches(session, retained.entry.providerSession?.id)
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: retained.entry.paneKey,
        worktreeIdHint: retained.worktreeId,
        tabIdHint: retained.entry.tabId ?? retained.tab.id
      })
      if (target) {
        return target
      }
    }
    if (
      agentMatches(session, retained.agentType) &&
      retained.entry.providerSession === undefined &&
      promptsMatchSession(session, retained.entry)
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: retained.entry.paneKey,
        worktreeIdHint: retained.worktreeId,
        tabIdHint: retained.entry.tabId ?? retained.tab.id
      })
      if (target) {
        promptMatchedTargets.push(target)
      }
    }
  }

  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (
      agentMatches(session, record.agent) &&
      providerSessionMatches(session, record.providerSession.id)
    ) {
      const target = resolveOriginalPaneTarget({
        state,
        paneKey: record.paneKey,
        worktreeIdHint: record.worktreeId,
        tabIdHint: record.tabId
      })
      if (target) {
        return target
      }
    }
  }

  return promptMatchedTargets.length === 1 ? promptMatchedTargets[0] : null
}
