import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type {
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TabsSlice } from './tabs-slice-contract'
import { insertSplitGroup } from './tabs-group-actions'
import { sanitizeRecentTabIds } from './tab-selection-history'
import { applyTabOrderSortValues } from '../../../../../shared/workspace-layout/tab-groups/tab-order'

type ChatPanelLayout = Pick<
  TabsSlice,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
>

export type ChatPanelWorkspaceMode = 'work' | 'code'

/** Code keeps editor tabs center and chat right; Work keeps chat first. */
export function chatPanelSideForMode(mode?: ChatPanelWorkspaceMode): 'first' | 'second' {
  return mode === 'code' ? 'second' : 'first'
}

function layoutHoldsChat(node: TabGroupLayoutNode, chatGroupIds: Set<string>): boolean {
  if (node.type === 'leaf') {
    return chatGroupIds.has(node.groupId)
  }
  return layoutHoldsChat(node.first, chatGroupIds) || layoutHoldsChat(node.second, chatGroupIds)
}

/** Swaps horizontal splits so the chat subtree sits on `side`; vertical splits keep order. */
export function normalizeLayoutChatSide(
  root: TabGroupLayoutNode,
  chatGroupIds: Set<string>,
  side: 'first' | 'second'
): TabGroupLayoutNode {
  if (root.type === 'leaf') {
    return root
  }
  const first = normalizeLayoutChatSide(root.first, chatGroupIds, side)
  const second = normalizeLayoutChatSide(root.second, chatGroupIds, side)
  if (root.direction !== 'horizontal') {
    return first === root.first && second === root.second ? root : { ...root, first, second }
  }
  const firstHasChat = layoutHoldsChat(first, chatGroupIds)
  const secondHasChat = layoutHoldsChat(second, chatGroupIds)
  if (firstHasChat === secondHasChat) {
    return first === root.first && second === root.second ? root : { ...root, first, second }
  }
  const chatFirst = firstHasChat && !secondHasChat
  const needsSwap = side === 'second' ? chatFirst : !chatFirst
  if (!needsSwap) {
    return first === root.first && second === root.second ? root : { ...root, first, second }
  }
  // Why: swapping columns mirrors the divider, so the content column keeps its width.
  return {
    ...root,
    first: second,
    second: first,
    ...(typeof root.ratio === 'number' ? { ratio: 1 - root.ratio } : {})
  }
}

export function normalizeWorktreeChatSide(
  layout: TabGroupLayoutNode | undefined,
  groups: readonly TabGroup[] | undefined,
  mode?: ChatPanelWorkspaceMode
): TabGroupLayoutNode | undefined {
  if (!layout || mode === undefined) {
    return layout
  }
  const chatGroupIds = new Set(
    (groups ?? []).filter((group) => group.isChatPanel).map((group) => group.id)
  )
  if (chatGroupIds.size === 0) {
    return layout
  }
  return normalizeLayoutChatSide(layout, chatGroupIds, chatPanelSideForMode(mode))
}

/**
 * The chat column is no longer pinned: closing or dragging out its last chat
 * collapses the split like any other pane. `applyDefaultChatPanelLayout` still
 * marks and separates chat groups, so this only affects the close/drag guard.
 */
export function shouldPinChatPanelColumn(): boolean {
  return false
}

/** Separate chat chrome without changing session identities or the focused content. */
export function applyDefaultChatPanelLayout(
  state: ChatPanelLayout,
  worktreeId: string,
  workspaceMode?: ChatPanelWorkspaceMode
): ChatPanelLayout {
  let next = state
  const chatSide = chatPanelSideForMode(workspaceMode)
  for (const group of state.groupsByWorktree[worktreeId] ?? []) {
    const tabs = next.unifiedTabsByWorktree[worktreeId] ?? []
    const chatIds = new Set(
      tabs
        .filter((tab) => tab.groupId === group.id && tab.contentType === 'agent-session')
        .map((tab) => tab.id)
    )
    if (chatIds.size === 0) {
      continue
    }
    const chatOrder = group.tabOrder.filter((id) => chatIds.has(id))
    const contentOrder = group.tabOrder.filter((id) => !chatIds.has(id))
    if (contentOrder.length === 0) {
      if (!group.isChatPanel) {
        next = {
          ...next,
          groupsByWorktree: {
            ...next.groupsByWorktree,
            [worktreeId]: next.groupsByWorktree[worktreeId].map((item) =>
              item.id === group.id ? { ...item, isChatPanel: true } : item
            )
          }
        }
      }
      continue
    }
    const chatGroupId = createBrowserUuid()
    const activeIsChat = group.activeTabId !== null && chatIds.has(group.activeTabId)
    const chatRecent = sanitizeRecentTabIds(group.recentTabIds, chatOrder)
    const contentRecent = sanitizeRecentTabIds(group.recentTabIds, contentOrder)
    const split = insertSplitGroup(
      next,
      worktreeId,
      {
        sourceGroupId: group.id,
        splitDirection: chatSide === 'second' ? 'right' : 'left',
        activate: next.activeGroupIdByWorktree[worktreeId] === group.id && activeIsChat
      },
      {
        id: chatGroupId,
        worktreeId,
        isChatPanel: true,
        activeTabId: activeIsChat ? group.activeTabId : (chatRecent.at(-1) ?? chatOrder[0]),
        tabOrder: chatOrder,
        recentTabIds: chatRecent
      }
    )
    const movedTabs = tabs.map((tab) =>
      chatIds.has(tab.id) ? { ...tab, groupId: chatGroupId } : tab
    )
    next = {
      ...split,
      unifiedTabsByWorktree: {
        ...next.unifiedTabsByWorktree,
        [worktreeId]: applyTabOrderSortValues(
          applyTabOrderSortValues(movedTabs, chatOrder),
          contentOrder
        )
      },
      groupsByWorktree: {
        ...split.groupsByWorktree,
        [worktreeId]: split.groupsByWorktree[worktreeId].map((item) =>
          item.id === group.id
            ? {
                ...item,
                isChatPanel: false,
                tabOrder: contentOrder,
                activeTabId:
                  !activeIsChat && group.activeTabId
                    ? group.activeTabId
                    : (contentRecent.at(-1) ?? contentOrder[0]),
                recentTabIds: contentRecent
              }
            : item
        )
      }
    }
  }
  if (workspaceMode !== undefined) {
    const normalized = normalizeWorktreeChatSide(
      next.layoutByWorktree[worktreeId],
      next.groupsByWorktree[worktreeId],
      workspaceMode
    )
    if (normalized && normalized !== next.layoutByWorktree[worktreeId]) {
      next = {
        ...next,
        layoutByWorktree: { ...next.layoutByWorktree, [worktreeId]: normalized }
      }
    }
  }
  return next
}
