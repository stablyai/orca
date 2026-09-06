import type { applyBrowserRecordUpdates } from './apply-browser-records'
import { withWorktreeEntry } from './state-equality-core'
import { sameGroups, sameUnifiedTabs } from './state-equality-files'
import { sameBrowserTabs as sameBrowserWorkspaces, sameTerminalTabs } from './state-equality-tabs'

type WorktreeRecordContext = ReturnType<typeof applyBrowserRecordUpdates>

/** Commit worktree-scoped tab collections and retain client-owned placement metadata. */
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
    retainedUnifiedTabs,
    mirroredUnifiedTabs,
    mirroredTerminalIds,
    nextTabBarOrder
  } = context

  const nextTabsByWorktree = withWorktreeEntry(
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

  // Group membership is the source of truth for a client-owned placement.
  const placedUnifiedTabs = (() => {
    if (!clientOwnedPlacement?.groups || !nextUnifiedTabs) {
      return nextUnifiedTabs
    }
    const groupIdByTabId = new Map(
      clientOwnedPlacement.groups.flatMap((group) =>
        group.tabOrder.map((tabId) => [tabId, group.id] as const)
      )
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
  const nextUnifiedTabsByWorktree = withWorktreeEntry(
    state,
    'unifiedTabsByWorktree',
    worktreeId,
    placedUnifiedTabs,
    sameUnifiedTabs,
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
