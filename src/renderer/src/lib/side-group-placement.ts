import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { findSiblingGroupId } from '@/store/slices/tabs'

/**
 * Where a "to the side" action should place its content: reuse the layout
 * sibling when the pane is already split, otherwise ask for a right split.
 * Shared by Open Preview to the Side and clicked-link routing; kept pure so
 * the resolution is testable without a store.
 */
export type SideGroupPlacement = { kind: 'existing'; groupId: string } | { kind: 'split-right' }

/**
 * Resolve which group an action originated from. The caller-supplied id wins
 * (the tab's own group under split-pane layouts, which is not necessarily the
 * focused one), then the worktree's active group, then its first group.
 */
export function resolveSourceGroupId(args: {
  requestedGroupId: string | null
  activeGroupId: string | null
  fallbackGroupId: string | null
}): string | null {
  return args.requestedGroupId ?? args.activeGroupId ?? args.fallbackGroupId ?? null
}

export function resolveSideGroupPlacement(args: {
  layout: TabGroupLayoutNode | null
  sourceGroupId: string
}): SideGroupPlacement {
  const sibling = args.layout ? findSiblingGroupId(args.layout, args.sourceGroupId) : null
  return sibling ? { kind: 'existing', groupId: sibling } : { kind: 'split-right' }
}
