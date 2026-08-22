import type { Tab, TabContentType, TabGroup } from '../../../../shared/tab-types'
import { sanitizeRecentTabIds } from './tab-group-state'

type TabCloseLandingState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  tabsByWorktree?: Record<string, { id: string }[]>
  browserTabsByWorktree?: Record<string, { id: string }[]>
  openFiles?: { id: string }[]
}

/** A landing tab is only usable while its backing entity still exists; unified
 *  rows can outlive it for a tick during hydration and bulk closes. */
function hasBackingEntity(state: TabCloseLandingState, tab: Tab): boolean {
  if (tab.contentType === 'terminal') {
    return (state.tabsByWorktree?.[tab.worktreeId] ?? []).some((row) => row.id === tab.entityId)
  }
  if (tab.contentType === 'browser') {
    return (state.browserTabsByWorktree?.[tab.worktreeId] ?? []).some(
      (row) => row.id === tab.entityId
    )
  }
  if (tab.contentType === 'simulator') {
    return true
  }
  return (state.openFiles ?? []).some((file) => file.id === tab.entityId)
}

/** Where focus lands when the last tab of a kind closes: the group's previously
 *  active tab, whatever kind it is. Cross-kind twin of `pickNextActiveTab`, so
 *  closing a browser tab returns to the terminal that opened it instead of the
 *  first tab in the workspace. Null means no MRU landing — caller falls back. */
export function pickTabCloseLanding(
  state: TabCloseLandingState,
  worktreeId: string,
  closing: { contentType: TabContentType; entityId: string }
): Tab | null {
  const worktreeTabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const closingTab = worktreeTabs.find(
    (tab) => tab.contentType === closing.contentType && tab.entityId === closing.entityId
  )
  if (!closingTab) {
    return null
  }
  const group = (state.groupsByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.id === closingTab.groupId
  )
  if (!group) {
    return null
  }
  const groupTabById = new Map(
    worktreeTabs.filter((tab) => tab.groupId === group.id).map((tab) => [tab.id, tab])
  )
  const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, group.tabOrder)
  for (let index = recentTabIds.length - 1; index >= 0; index--) {
    const candidateId = recentTabIds[index]
    if (candidateId === closingTab.id) {
      continue
    }
    const candidate = groupTabById.get(candidateId)
    if (candidate && hasBackingEntity(state, candidate)) {
      return candidate
    }
  }
  return null
}
