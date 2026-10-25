import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import type { EditorOpenLinkIntent } from '@/store/slices/editor/types/editor-open-link-intent'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'

export type LinkOpenIntent = EditorOpenLinkIntent & { initialGroupId?: string }
export type LinkSourceTab = Pick<Tab, 'id' | 'entityId' | 'groupId'> &
  Partial<Pick<Tab, 'contentType' | 'executionHostId'>>
export type LinkSourceState = { unifiedTabsByWorktree?: Record<string, LinkSourceTab[]> }

export type LinkPlacementState = Pick<
  AppState,
  'groupsByWorktree' | 'unifiedTabsByWorktree' | 'layoutByWorktree'
>

/** The unified tab a link came from; a terminal surface may know only its backing terminal id. */
function findLinkSourceTab(
  tabs: readonly LinkSourceTab[],
  sourceTabId: string
): LinkSourceTab | undefined {
  return (
    tabs.find((tab) => tab.id === sourceTabId) ??
    tabs.find((tab) => tab.contentType === 'terminal' && tab.entityId === sourceTabId)
  )
}

/** Captures a link activation's source at click time, so later focus changes cannot redirect it. */
export function captureLinkOpenIntent(
  state: LinkSourceState,
  workspaceId: string,
  sourceTabId: string | null | undefined,
  options?: { explicitSourceGroup?: boolean }
): LinkOpenIntent | null {
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
    initialGroupId: tab.groupId,
    ...(options?.explicitSourceGroup ? { targetGroupId: tab.groupId } : {})
  }
}

export function liveLinkOpenGroupIds(
  state: Partial<Pick<LinkPlacementState, 'groupsByWorktree' | 'layoutByWorktree'>>,
  worktreeId: string
): Set<string> {
  const layout = state.layoutByWorktree?.[worktreeId]
  const groupIds = new Set((state.groupsByWorktree?.[worktreeId] ?? []).map((group) => group.id))
  if (!layout) {
    return groupIds
  }
  return new Set([...collectTabGroupLayoutGroupIds(layout)].filter((id) => groupIds.has(id)))
}

export function isLiveLinkOpenGroup(
  state: LinkPlacementState,
  worktreeId: string,
  groupId: string
): boolean {
  return liveLinkOpenGroupIds(state, worktreeId).has(groupId)
}

/** "Open in this group" only differs from automatic placement when the source has company. */
export function canOpenLinkInSourceGroup(
  state: Partial<Pick<LinkPlacementState, 'groupsByWorktree' | 'layoutByWorktree'>> &
    LinkSourceState,
  workspaceId: string,
  sourceTabId: string | null | undefined
): boolean {
  const tab = sourceTabId
    ? findLinkSourceTab(state.unifiedTabsByWorktree?.[workspaceId] ?? [], sourceTabId)
    : undefined
  if (!tab) {
    return false
  }
  const groupIds = liveLinkOpenGroupIds(state, workspaceId)
  return groupIds.has(tab.groupId) && groupIds.size > 1
}
