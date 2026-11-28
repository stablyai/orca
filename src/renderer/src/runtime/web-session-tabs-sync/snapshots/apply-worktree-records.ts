import type { applyBrowserRecordUpdates } from './apply-browser-records'
import { withWorktreeEntry } from './state-equality-core'
import {
  finishPresentationRecord,
  presentationRecordDraft,
  withWorktreeTabEntry
} from './presentation-record-drafts'
import { sameGroups, sameUnifiedTabs } from './state-equality-files'
import { sameBrowserTabs as sameBrowserWorkspaces, sameTerminalTabs } from './state-equality-tabs'

type WorktreeRecordContext = ReturnType<typeof applyBrowserRecordUpdates>

export function applyWorktreeRecordUpdates(context: WorktreeRecordContext) {
  const {
    state,
    batchContext,
    worktreeId,
    nextTerminalTabs,
    nextBrowserTabs,
    nextUnifiedTabs,
    nextGroups,
    clientOwnedPlacement,
    adoptsInitialHostGroups,
    retainedUnifiedTabs,
    mirroredUnifiedTabs,
    mirroredTerminalIds,
    nextTabBarOrder
  } = context

  const nextTabsByWorktree = withWorktreeTabEntry(
    state,
    'tabsByWorktree',
    worktreeId,
    nextTerminalTabs,
    sameTerminalTabs,
    batchContext
  )
  const nextBrowserTabsByWorktree = withWorktreeEntry(
    state,
    'browserTabsByWorktree',
    worktreeId,
    nextBrowserTabs,
    sameBrowserWorkspaces,
    batchContext
  )

  // Group membership is the source of truth for client placement and initial host adoption.
  const placedUnifiedTabs = (() => {
    const groups = clientOwnedPlacement?.groups ?? (adoptsInitialHostGroups ? nextGroups : null)
    if (!groups || !nextUnifiedTabs) {
      return nextUnifiedTabs
    }
    const groupIdByTabId = new Map(
      groups.flatMap((group) => group.tabOrder.map((tabId) => [tabId, group.id] as const))
    )
    let changed = false
    const placed = nextUnifiedTabs.map((tab) => {
      const groupId = groupIdByTabId.get(tab.id)
      if (!groupId || groupId === tab.groupId) {
        return tab
      }
      changed = true
      return { ...tab, groupId }
    })
    return changed ? placed : nextUnifiedTabs
  })()
  const unifiedTabsKey = 'unifiedTabsByWorktree'
  const unifiedTabsDraft = presentationRecordDraft(state, unifiedTabsKey, batchContext)
  if (!sameUnifiedTabs(unifiedTabsDraft.get(worktreeId), placedUnifiedTabs)) {
    if (placedUnifiedTabs === null) {
      unifiedTabsDraft.delete(worktreeId)
    } else {
      unifiedTabsDraft.set(worktreeId, placedUnifiedTabs)
    }
  }
  for (const { unifiedTab } of context.mirroredBrowserTabs) {
    if (unifiedTab.worktreeId === worktreeId) {
      continue
    }
    const tabs = unifiedTabsDraft.get(unifiedTab.worktreeId)
    const nextTabs = tabs?.map((tab) => (tab.id === unifiedTab.id ? unifiedTab : tab))
    if (nextTabs && !sameUnifiedTabs(tabs, nextTabs)) {
      unifiedTabsDraft.set(unifiedTab.worktreeId, nextTabs)
    }
  }
  const nextUnifiedTabsByWorktree = finishPresentationRecord(
    state,
    unifiedTabsKey,
    unifiedTabsDraft,
    batchContext
  )
  const nextGroupsByWorktree = withWorktreeEntry(
    state,
    'groupsByWorktree',
    worktreeId,
    nextGroups,
    sameGroups,
    batchContext
  )

  return {
    ...context,
    nextTabsByWorktree,
    nextBrowserTabsByWorktree,
    placedUnifiedTabs,
    nextUnifiedTabsByWorktree,
    nextGroupsByWorktree,
    mirroredTerminalIds,
    retainedUnifiedTabs,
    mirroredUnifiedTabs,
    nextTabBarOrder
  }
}
