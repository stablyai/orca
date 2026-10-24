import type { AppState } from '../../../types'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import { editorTabContentTypeForMode, isEditorTabContentType } from './editor-tab-content-type'
import type { OpenFile } from '../types/open-file'
import { ownsGlobalSelection } from '../../../global-selection-owner'
import type { EditorOpenLinkIntent } from '../types/editor-open-link-intent'
import { pickAdjacentEditorOpenGroupId } from './editor-open-adjacent-group'
import { collectTabGroupLayoutGroupIds } from '../../../../../../shared/workspace-layout/tab-group-moves'

export function getGroupActiveTab(group: TabGroup, tabsById: Map<string, Tab>): Tab | null {
  return group.activeTabId ? (tabsById.get(group.activeTabId) ?? null) : null
}

export function getMostRecentEditorTabForGroup(
  group: TabGroup,
  tabsById: Map<string, Tab>
): Tab | null {
  const seen = new Set<string>()
  const candidateIdLists = [group.recentTabIds ?? [], group.tabOrder]
  for (const candidateIds of candidateIdLists) {
    for (let index = candidateIds.length - 1; index >= 0; index -= 1) {
      const tabId = candidateIds[index]
      if (!tabId || seen.has(tabId)) {
        continue
      }
      seen.add(tabId)
      const tab = tabsById.get(tabId)
      if (tab?.groupId === group.id && isEditorTabContentType(tab.contentType)) {
        return tab
      }
    }
  }
  return null
}

export function resolveEditorOpenTargetGroupId(
  state: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  explicitTargetGroupId?: string
): string | undefined {
  if (explicitTargetGroupId) {
    return explicitTargetGroupId
  }

  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  if (groups.length === 0) {
    return undefined
  }

  const fallbackGroup = groups[0]
  if (!fallbackGroup) {
    return undefined
  }
  const tabsById = new Map(
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  const activeGroup =
    groups.find((group) => group.id === state.activeGroupIdByWorktree?.[worktreeId]) ??
    fallbackGroup
  const activeTab = getGroupActiveTab(activeGroup, tabsById)
  // Why: only a focused agent *terminal* should defer to an existing editor pane
  // (#6891). Editor, browser, and simulator panes open the file in the focused
  // group so it lands where the user is looking instead of a stale editor pane.
  if (!activeTab || activeTab.contentType !== 'terminal') {
    return activeGroup.id
  }

  // Why: reuse an existing editor pane rather than turning a focused agent-terminal pane into an editor tab.
  const visibleEditorGroup = groups.find((group) => {
    if (group.id === activeGroup.id) {
      return false
    }
    const groupActiveTab = getGroupActiveTab(group, tabsById)
    return groupActiveTab ? isEditorTabContentType(groupActiveTab.contentType) : false
  })
  if (visibleEditorGroup) {
    return visibleEditorGroup.id
  }

  const recentEditorGroup = groups.find(
    (group) => group.id !== activeGroup.id && getMostRecentEditorTabForGroup(group, tabsById)
  )
  return recentEditorGroup?.id ?? activeGroup.id
}

type LinkPlacementState = Pick<
  AppState,
  'groupsByWorktree' | 'unifiedTabsByWorktree' | 'layoutByWorktree'
>

/** The unified tab a link came from; a terminal surface may know only its backing terminal id. */
function findLinkSourceTab(tabs: readonly Tab[], sourceTabId: string): Tab | undefined {
  return (
    tabs.find((tab) => tab.id === sourceTabId) ??
    tabs.find((tab) => tab.contentType === 'terminal' && tab.entityId === sourceTabId)
  )
}

/** Captures a link activation's source at click time, so later focus changes cannot redirect it. */
export function captureEditorOpenLinkIntent(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  workspaceId: string,
  sourceTabId: string | null | undefined,
  options?: { explicitSourceGroup?: boolean }
): EditorOpenLinkIntent | null {
  if (!sourceTabId) {
    return null
  }
  const tab = findLinkSourceTab(state.unifiedTabsByWorktree?.[workspaceId] ?? [], sourceTabId)
  if (!tab) {
    return null
  }
  return {
    sourceTabId: tab.id,
    workspaceId,
    hostId: tab.executionHostId ?? null,
    ...(options?.explicitSourceGroup ? { targetGroupId: tab.groupId } : {})
  }
}

export function liveLayoutGroupIds(
  state: {
    layoutByWorktree?: LinkPlacementState['layoutByWorktree']
    groupsByWorktree?: Record<string, readonly Pick<TabGroup, 'id'>[]>
  },
  worktreeId: string
): Set<string> {
  const layout = state.layoutByWorktree?.[worktreeId]
  const groupIds = new Set((state.groupsByWorktree?.[worktreeId] ?? []).map((group) => group.id))
  if (!layout) {
    return groupIds
  }
  return new Set([...collectTabGroupLayoutGroupIds(layout)].filter((id) => groupIds.has(id)))
}

export function isLiveEditorOpenGroup(
  state: LinkPlacementState,
  worktreeId: string,
  groupId: string
): boolean {
  return liveLayoutGroupIds(state, worktreeId).has(groupId)
}

/** "Open in this group" only differs from automatic placement when the source has company. */
export function canOpenLinkInSourceGroup(
  state: LinkPlacementState,
  workspaceId: string,
  sourceTabId: string | null | undefined
): boolean {
  const tab = sourceTabId
    ? findLinkSourceTab(state.unifiedTabsByWorktree?.[workspaceId] ?? [], sourceTabId)
    : undefined
  if (!tab) {
    return false
  }
  const groupIds = liveLayoutGroupIds(state, workspaceId)
  return groupIds.has(tab.groupId) && groupIds.size > 1
}

export type EditorLinkOpenPlacement =
  | { kind: 'group'; groupId: string }
  | { kind: 'default' }
  | { kind: 'refused' }

/**
 * Link-intent extension of resolveEditorOpenTargetGroupId: an explicit target is honored
 * or refused as captured; an automatic open ranks groups around the source's current group.
 */
export function resolveEditorLinkOpenPlacement(
  state: LinkPlacementState,
  worktreeId: string,
  intent: EditorOpenLinkIntent,
  fileId: string,
  mode: OpenFile['mode']
): EditorLinkOpenPlacement {
  if (intent.targetGroupId) {
    return intent.workspaceId === worktreeId &&
      isLiveEditorOpenGroup(state, worktreeId, intent.targetGroupId)
      ? { kind: 'group', groupId: intent.targetGroupId }
      : { kind: 'refused' }
  }
  // Why: groups in another workspace's layout have no spatial relationship to the source.
  if (intent.workspaceId !== worktreeId) {
    return { kind: 'default' }
  }
  const layout = state.layoutByWorktree?.[worktreeId]
  const tabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const source = tabs.find((tab) => tab.id === intent.sourceTabId)
  // Why: a closed or re-hosted source falls back to defaults, never to its stale initial group.
  if (!layout || !source || (source.executionHostId ?? null) !== intent.hostId) {
    return { kind: 'default' }
  }
  const groupId = pickAdjacentEditorOpenGroupId({
    layout,
    groups: state.groupsByWorktree?.[worktreeId] ?? [],
    tabs,
    sourceGroupId: source.groupId,
    fileId,
    contentType: editorTabContentTypeForMode(mode)
  })
  return groupId ? { kind: 'group', groupId } : { kind: 'default' }
}

export function buildEditorActiveResult(
  state: Pick<AppState, 'activeFileIdByWorktree' | 'activeTabTypeByWorktree' | 'activeWorktreeId'>,
  worktreeId: string,
  fileId: string
): {
  activeFileId?: string
  activeTabType?: 'editor'
  activeFileIdByWorktree: Record<string, string | null>
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
} {
  return {
    // Why: only the on-screen worktree owns the main editor; a background or floating open updates only the per-worktree maps.
    ...(ownsGlobalSelection(state, worktreeId)
      ? { activeFileId: fileId, activeTabType: 'editor' as const }
      : {}),
    activeFileIdByWorktree: { ...state.activeFileIdByWorktree, [worktreeId]: fileId },
    activeTabTypeByWorktree: { ...state.activeTabTypeByWorktree, [worktreeId]: 'editor' }
  }
}
