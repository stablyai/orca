import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'

export function getPersistedEditFileIdsByWorktree(
  session: WorkspaceSessionState
): Record<string, Set<string>> {
  return Object.fromEntries(
    Object.entries(session.openFilesByWorktree ?? {}).map(([worktreeId, files]) => [
      worktreeId,
      new Set(files.map((file) => file.filePath))
    ])
  )
}

export function selectHydratedActiveGroupId(
  groups: TabGroup[],
  persistedActiveGroupId?: string
): string | undefined {
  const preferredGroups = groups.filter((group) => group.tabOrder.length > 0)
  const candidates = preferredGroups.length > 0 ? preferredGroups : groups
  if (persistedActiveGroupId && candidates.some((group) => group.id === persistedActiveGroupId)) {
    return persistedActiveGroupId
  }
  return candidates[0]?.id
}

/** Hydration must remove duplicate IDs left by editor-owner migration; repeated React keys otherwise strand ghost rows. */
export function dedupeTabsById<T extends { id: string }>(tabs: T[]): T[] {
  const seen = new Set<string>()
  return tabs.filter((tab) => {
    if (seen.has(tab.id)) {
      return false
    }
    seen.add(tab.id)
    return true
  })
}

export function dedupeEditorTabsWithinGroups(tabs: Tab[]): {
  tabs: Tab[]
  tabIdAliasesByGroup: Map<string, Map<string, string>>
} {
  const tabIdAliasesByGroup = new Map<string, Map<string, string>>()
  const editorTabIdByGroupAndEntity = new Map<string, Map<string, string>>()
  const dedupedTabs = dedupeTabsById(tabs).filter((tab) => {
    if (tab.contentType !== 'editor') {
      return true
    }
    const editorTabIdByEntity =
      editorTabIdByGroupAndEntity.get(tab.groupId) ?? new Map<string, string>()
    editorTabIdByGroupAndEntity.set(tab.groupId, editorTabIdByEntity)
    const existingTabId = editorTabIdByEntity.get(tab.entityId)
    if (existingTabId !== undefined) {
      const tabIdAliases = tabIdAliasesByGroup.get(tab.groupId) ?? new Map<string, string>()
      tabIdAliasesByGroup.set(tab.groupId, tabIdAliases)
      tabIdAliases.set(tab.id, existingTabId)
      return false
    }
    editorTabIdByEntity.set(tab.entityId, tab.id)
    return true
  })
  return { tabs: dedupedTabs, tabIdAliasesByGroup }
}
