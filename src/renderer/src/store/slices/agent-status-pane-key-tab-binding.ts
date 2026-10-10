import type { AppState } from '../types'
import type {
  AgentStatusEntry,
  AgentType,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DropAgentStatusByWorktreeOptions, RetainedAgentEntry } from './agent-status-contract'
import type { AgentStatusTabPrefixDropState } from './agent-status-drop-reducer'

export function paneKeyMatchesAnyTabPrefix(paneKey: string, tabPrefixes: string[]): boolean {
  for (const prefix of tabPrefixes) {
    if (paneKey.startsWith(prefix)) {
      return true
    }
  }
  return false
}

export function isAgentCompletionState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

export function getTabIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  return paneKey.slice(0, separator)
}

/** True when auto-title generation would no-op without replace (custom/quick/generated). */
export function agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
  state: AppState,
  tabId: string | null,
  worktreeId?: string | null
): boolean {
  if (!tabId) {
    return false
  }
  const ownerTabs = worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  if (ownerTabs) {
    const tab = ownerTabs.find((candidate) => candidate.id === tabId)
    return Boolean(
      tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.generatedTitle?.trim()
    )
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(
      tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || tab.generatedTitle?.trim()
    )
  }
  return false
}

export function getLeafIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  const leafId = paneKey.slice(separator + 1)
  return leafId.length > 0 ? leafId : null
}

export function findCompletedOrphanPaneKeysForTabClose(
  state: AgentStatusTabPrefixDropState,
  worktreeId: string | undefined,
  prefix: string
): string[] {
  if (!worktreeId) {
    return []
  }
  const openTabIds = new Set((state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  const paneKeys: string[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (paneKey.startsWith(prefix) || entry.state !== 'done' || entry.worktreeId !== worktreeId) {
      continue
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    if (!tabId || openTabIds.has(tabId)) {
      continue
    }
    paneKeys.push(paneKey)
  }
  return paneKeys
}

export function isRecentlyClosedAgentStatusTab(
  closedTabs: Record<string, true>,
  tabId: string | null
): boolean {
  if (!tabId) {
    return false
  }
  return closedTabs[tabId] === true
}

export function findAgentPaneWorktreeId(state: AppState, paneKey: string): string | null {
  const tabId = getTabIdFromPaneKey(paneKey)
  if (!tabId) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

export function findTabForAgentEntry(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry
): TerminalTab | undefined {
  const tabId = entry.tabId ?? getTabIdFromPaneKey(entry.paneKey)
  if (!tabId) {
    return undefined
  }
  return (state.tabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === tabId)
}

export function getRetainedFallbackTab(entry: AgentStatusEntry, worktreeId: string): TerminalTab {
  const tabId = entry.tabId ?? getTabIdFromPaneKey(entry.paneKey) ?? entry.paneKey
  return {
    id: tabId,
    ptyId: null,
    worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: entry.stateStartedAt
  }
}

export function retainedAgentEntryFromLive(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry,
  agentType: AgentType
): RetainedAgentEntry {
  const tab =
    findTabForAgentEntry(state, worktreeId, entry) ?? getRetainedFallbackTab(entry, worktreeId)
  return {
    entry,
    worktreeId,
    tab,
    agentType,
    startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
  }
}

export function shouldReplaceRetainedWithLive(
  retained: RetainedAgentEntry | undefined,
  live: RetainedAgentEntry
): boolean {
  if (!retained) {
    return true
  }
  if (live.startedAt !== retained.startedAt) {
    return live.startedAt > retained.startedAt
  }
  const retainedSessionId = retained.entry.providerSession?.id
  const liveSessionId = live.entry.providerSession?.id
  if (retainedSessionId && liveSessionId && retainedSessionId !== liveSessionId) {
    return live.entry.updatedAt >= retained.entry.updatedAt
  }
  return live.entry.updatedAt > retained.entry.updatedAt
}

export function normalizePaneKeySet(
  paneKeys: DropAgentStatusByWorktreeOptions['sleepingPaneKeys']
): ReadonlySet<string> | null {
  if (!paneKeys) {
    return null
  }
  return paneKeys instanceof Set ? paneKeys : new Set(paneKeys)
}
