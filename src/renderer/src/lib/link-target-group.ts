import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { resolveSideGroupPlacement, resolveSourceGroupId } from './side-group-placement'

/**
 * Where a clicked in-app link should open. `active-group` keeps the historical
 * behavior (another tab in the worktree's active group); the other two place it
 * beside the pane the click came from.
 */
export type LinkTargetGroupPlan =
  | { kind: 'active-group' }
  | { kind: 'existing'; groupId: string }
  | { kind: 'split-right'; sourceGroupId: string }

/**
 * Pure resolution so the placement rules are testable without a store. The
 * source group is the clicked page's own group rather than the focused one —
 * a link clicked in an unfocused pane still opens next to itself.
 */
export function resolveLinkTargetGroupPlan(args: {
  enabled: boolean
  workspaceId: string
  tabs: readonly { entityId: string; groupId: string }[]
  activeGroupId: string | null
  firstGroupId: string | null
  layout: TabGroupLayoutNode | null
}): LinkTargetGroupPlan {
  if (!args.enabled) {
    return { kind: 'active-group' }
  }
  const sourceGroupId = resolveSourceGroupId({
    requestedGroupId: args.tabs.find((tab) => tab.entityId === args.workspaceId)?.groupId ?? null,
    activeGroupId: args.activeGroupId,
    fallbackGroupId: args.firstGroupId
  })
  if (!sourceGroupId) {
    return { kind: 'active-group' }
  }
  const placement = resolveSideGroupPlacement({ layout: args.layout, sourceGroupId })
  return placement.kind === 'existing'
    ? { kind: 'existing', groupId: placement.groupId }
    : { kind: 'split-right', sourceGroupId }
}

type LinkTargetStore = {
  // Settings hydrate asynchronously; a null store means the setting is not on yet.
  settings: { openLinksInSidePane?: boolean } | null
  unifiedTabsByWorktree: Record<string, { entityId: string; groupId: string }[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, { id: string }[] | undefined>
  layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>
  createEmptySplitGroup: (
    worktreeId: string,
    sourceGroupId: string,
    direction: 'right'
  ) => string | null
}

/**
 * Resolve the group a clicked link should open in, creating the right-hand
 * split when the setting is on and the source pane has no sibling. Returns null
 * to mean "let createBrowserTab use the active group" — including when a split
 * cannot be created, so link-opening degrades to a tab rather than failing.
 */
export function resolveLinkTargetGroupId(
  store: LinkTargetStore,
  sourcePage: { worktreeId: string; workspaceId: string }
): string | null {
  // Why: when the setting is off, degrade to the active group without touching
  // per-worktree layout maps — the opener may fire before they are populated.
  if (store.settings?.openLinksInSidePane !== true) {
    return null
  }
  const { worktreeId, workspaceId } = sourcePage
  const plan = resolveLinkTargetGroupPlan({
    enabled: true,
    workspaceId,
    tabs: store.unifiedTabsByWorktree[worktreeId] ?? [],
    activeGroupId: store.activeGroupIdByWorktree[worktreeId] ?? null,
    firstGroupId: store.groupsByWorktree[worktreeId]?.[0]?.id ?? null,
    layout: store.layoutByWorktree[worktreeId] ?? null
  })
  if (plan.kind === 'active-group') {
    return null
  }
  if (plan.kind === 'existing') {
    return plan.groupId
  }
  return store.createEmptySplitGroup(worktreeId, plan.sourceGroupId, 'right')
}
