import type { AppState } from '../../types'
import type {
  AgentStatusEntry,
  ParsedAgentStatusPayload
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { tabHasProtectedTitle } from '../../../../../shared/agent-status/presentation/agent-generated-tab-title-rules'
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
    return Boolean(tab && (tabHasProtectedTitle(tab) || tab.generatedTitle?.trim()))
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(tabHasProtectedTitle(tab) || tab.generatedTitle?.trim())
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

/** Unified chat/nonterminal rows own their cleanup. Terminal ownership requires terminal inventory because unified metadata can lag close. */
export function openNonTerminalTabIds(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  worktreeId: string
): Set<string> {
  const tabIds = new Set<string>()
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (tab.contentType !== 'terminal') {
      tabIds.add(tab.id)
    }
  }
  return tabIds
}

export function findCompletedOrphanPaneKeysForTabClose(
  state: AgentStatusTabPrefixDropState,
  worktreeId: string | undefined,
  prefix: string
): string[] {
  if (!worktreeId) {
    return []
  }
  const openTabIds = openNonTerminalTabIds(state, worktreeId)
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    openTabIds.add(tab.id)
  }
  const paneKeys: string[] = []
  for (const paneKey of new Set([
    ...state.agentStatusByPaneKey.projection.orphanKeys(worktreeId),
    ...state.agentStatusByPaneKey.stagedKeys()
  ])) {
    const entry = state.agentStatusByPaneKey.get(paneKey)
    if (!entry) {
      continue
    }
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

export function findAgentPaneWorktreeId(
  state: Pick<AppState, 'tabsByWorktree'>,
  paneKey: string
): string | null {
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
