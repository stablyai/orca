import { resolveRightSplitTargetGroupId } from '@/lib/right-split-target-group'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import type {
  Tab,
  TabContentType,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/tab-types'

/** Every map is optional: partial harness stores and pre-hydration state reach this predicate. */
type LonePaneState = {
  layoutByWorktree?: Record<string, TabGroupLayoutNode | undefined>
  groupsByWorktree?: Record<string, TabGroup[] | undefined>
  unifiedTabsByWorktree?: Record<string, Tab[] | undefined>
  activeGroupIdByWorktree?: Record<string, string | undefined>
}

/** The one group a worktree's tab area is showing, when the next pane should open beside it.
 *  null once the area is split (the ceiling of two), while the lone group is still empty
 *  (nothing to sit beside), and for the floating panel, which never renders a split layout. */
export function findLonePaneSourceGroupId(
  state: LonePaneState,
  worktreeId: string,
  requestedGroupId?: string
): string | null {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const layout = state.layoutByWorktree?.[worktreeId]
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const loneGroupId = layout
    ? layout.type === 'leaf'
      ? layout.groupId
      : null
    : groups.length === 1
      ? (groups[0]?.id ?? null)
      : null
  if (loneGroupId === null || !groups.some((group) => group.id === loneGroupId)) {
    return null
  }
  // Why: a caller naming some other group has placement intent of its own; only "put it where I'm looking" is redirected.
  if (requestedGroupId !== undefined && requestedGroupId !== loneGroupId) {
    return null
  }
  // Why unified tabs, not tabOrder: an orphaned runtime terminal sits in tabOrder but renders nothing.
  return (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
    (tab) => tab.groupId === loneGroupId
  )
    ? loneGroupId
    : null
}

/** With the area split in exactly two, the panel a new tab opens in. The split reads as a terminal
 *  side and a content side: a terminal joins the side showing a terminal, anything else the side
 *  showing content. When both sides show the same kind, it opens opposite where the user is.
 *  null leaves the caller's placement alone. */
export function findSplitOppositeGroupId(
  state: LonePaneState,
  worktreeId: string,
  requestedGroupId?: string,
  contentType?: TabContentType
): string | null {
  const layout = state.layoutByWorktree?.[worktreeId]
  if (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    layout?.type !== 'split' ||
    layout.first.type !== 'leaf' ||
    layout.second.type !== 'leaf'
  ) {
    return null
  }
  const activeGroupId = state.activeGroupIdByWorktree?.[worktreeId]
  const sourceGroupId = requestedGroupId ?? activeGroupId
  // Why: naming the unfocused panel (Open to the Side, a fresh split) is placement intent of its own.
  if (sourceGroupId === undefined || sourceGroupId !== activeGroupId) {
    return null
  }
  const otherGroupId =
    layout.first.groupId === sourceGroupId
      ? layout.second.groupId
      : layout.second.groupId === sourceGroupId
        ? layout.first.groupId
        : null
  if (
    otherGroupId === null ||
    !state.groupsByWorktree?.[worktreeId]?.some((g) => g.id === otherGroupId)
  ) {
    return null
  }
  const sourceKind = groupKind(state, worktreeId, sourceGroupId)
  // Why: an empty panel has nothing to keep visible, so filling it is where the user is looking.
  if (sourceKind === null) {
    return null
  }
  const otherKind = groupKind(state, worktreeId, otherGroupId)
  if (otherKind !== null && otherKind !== sourceKind) {
    const newKind = contentType === 'terminal' ? 'terminal' : 'content'
    return newKind === sourceKind ? null : otherGroupId
  }
  return otherGroupId
}

type BesideGroupState = LonePaneState & Parameters<typeof resolveRightSplitTargetGroupId>[0]

/** The group the next tab opens in when placement is automatic — null keeps the caller's.
 *  One pane: a new pane beside it, unfocused and untracked (a host snapshot reads an activated
 *  empty group as a pane, and the user did not split anything). Two: see findSplitOppositeGroupId. */
export function resolveAutoPlacementGroupId(
  state: BesideGroupState,
  worktreeId: string,
  requestedGroupId?: string,
  contentType?: TabContentType
): string | null {
  const oppositeGroupId = findSplitOppositeGroupId(state, worktreeId, requestedGroupId, contentType)
  if (oppositeGroupId !== null) {
    return oppositeGroupId
  }
  const loneGroupId = findLonePaneSourceGroupId(state, worktreeId, requestedGroupId)
  // Why: a browser joins a lone pane already showing a browser as another tab, not a split.
  return loneGroupId === null ||
    (contentType === 'browser' && groupShowsBrowser(state, worktreeId, loneGroupId))
    ? null
    : resolveRightSplitTargetGroupId(state, worktreeId, loneGroupId, {
        activate: false,
        recordInteraction: false
      })
}

function groupKind(
  state: LonePaneState,
  worktreeId: string,
  groupId: string
): 'terminal' | 'content' | null {
  const activeTabId = state.groupsByWorktree?.[worktreeId]?.find(
    (g) => g.id === groupId
  )?.activeTabId
  const tabs = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).filter(
    (tab) => tab.groupId === groupId
  )
  const shown = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]
  return shown ? (shown.contentType === 'terminal' ? 'terminal' : 'content') : null
}

function groupShowsBrowser(state: LonePaneState, worktreeId: string, groupId: string): boolean {
  const activeTabId = state.groupsByWorktree?.[worktreeId]?.find(
    (g) => g.id === groupId
  )?.activeTabId
  return (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
    (tab) => tab.id === activeTabId && tab.contentType === 'browser'
  )
}
