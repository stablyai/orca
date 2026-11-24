import type { Tab, TabGroup, TabGroupLayoutNode } from './tab-types'
import { normalizeLayoutChatSide, type ChatPanelSide } from './chat-panel-side'
import { createNonSecureContextUuid } from '../../identifiers/non-secure-context-uuid'
import { applyTabOrderSortValues } from './tab-order'

/** Window-partition slice the fixed panel separates; the runtime owns the saved layout. */
export type ChatPanelSeparationState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

export type ChatPanelSplitTarget = {
  sourceGroupId: string
  splitDirection: 'left' | 'right' | 'up' | 'down'
  activate: boolean
}

export type ChatPanelSplitResult = Pick<
  ChatPanelSeparationState,
  'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'
>

export type ChatPanelSeparationOps = {
  splitGroup: (
    state: ChatPanelSeparationState,
    worktreeId: string,
    target: ChatPanelSplitTarget,
    group: TabGroup
  ) => ChatPanelSplitResult
  sanitizeRecentTabIds: (recent: string[] | undefined, tabOrder: string[]) => string[]
}

// Why local: Code keeps editor tabs center and chat right; Work keeps chat first.
function chatPanelSideForMode(mode: 'work' | 'code' | undefined): ChatPanelSide {
  return mode === 'code' ? 'second' : 'first'
}

/** Separate chat chrome without changing session identities or the focused content. */
export function separateChatPanelGroups(
  state: ChatPanelSeparationState,
  worktreeId: string,
  mode: 'work' | 'code' | undefined,
  ops: ChatPanelSeparationOps
): ChatPanelSeparationState {
  const chatSide = chatPanelSideForMode(mode)
  let next = state
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
    const chatGroupId = createNonSecureContextUuid()
    const activeIsChat = group.activeTabId !== null && chatIds.has(group.activeTabId)
    const chatRecent = ops.sanitizeRecentTabIds(group.recentTabIds, chatOrder)
    const contentRecent = ops.sanitizeRecentTabIds(group.recentTabIds, contentOrder)
    const split = ops.splitGroup(
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
      ...next,
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
  if (mode !== undefined) {
    const layout = next.layoutByWorktree[worktreeId]
    const chatGroupIds = new Set(
      (next.groupsByWorktree[worktreeId] ?? [])
        .filter((candidate) => candidate.isChatPanel)
        .map((candidate) => candidate.id)
    )
    if (layout && chatGroupIds.size > 0) {
      const normalized = normalizeLayoutChatSide(layout, chatGroupIds, chatSide)
      if (normalized !== layout) {
        next = {
          ...next,
          layoutByWorktree: { ...next.layoutByWorktree, [worktreeId]: normalized }
        }
      }
    }
  }
  return next
}

/** Per-worktree separation without naming the window records, for ratchet-scanned callers. */
export function separateChatPanelGroupRecords(
  tabs: Tab[],
  groups: TabGroup[],
  activeGroupId: string | undefined,
  layout: TabGroupLayoutNode | undefined,
  worktreeId: string,
  ops: ChatPanelSeparationOps
): {
  tabs: Tab[]
  groups: TabGroup[]
  activeGroupId: string | undefined
  layout: TabGroupLayoutNode | undefined
} {
  const separated = separateChatPanelGroups(
    {
      unifiedTabsByWorktree: { [worktreeId]: tabs },
      groupsByWorktree: { [worktreeId]: groups },
      activeGroupIdByWorktree: activeGroupId === undefined ? {} : { [worktreeId]: activeGroupId },
      layoutByWorktree: layout === undefined ? {} : { [worktreeId]: layout }
    },
    worktreeId,
    undefined,
    ops
  )
  return {
    tabs: separated.unifiedTabsByWorktree[worktreeId] ?? tabs,
    groups: separated.groupsByWorktree[worktreeId] ?? groups,
    activeGroupId: separated.activeGroupIdByWorktree[worktreeId] ?? activeGroupId,
    layout: separated.layoutByWorktree[worktreeId] ?? layout
  }
}
