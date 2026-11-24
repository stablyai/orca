import type {
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TabsSlice, TabSplitTarget } from './tabs-slice-contract'
import { insertSplitGroup } from './tabs-group-actions'
import { sanitizeRecentTabIds } from './tab-selection-history'
import {
  normalizeLayoutChatSide,
  type ChatPanelSide
} from '../../../../../shared/workspace-layout/tab-groups/chat-panel-side'
import { separateChatPanelGroups } from '../../../../../shared/workspace-layout/tab-groups/chat-panel-separation'
import { collectTabGroupLayoutGroupIds } from '../../../../../shared/workspace-layout/tab-groups/tab-group-moves'
import { resolveWorkspaceMode } from '../../../app-shell/workspace-mode'

export type ChatPanelWorkspaceMode = 'work' | 'code'

type ChatPanelLayout = Pick<
  TabsSlice,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
>

/** Separate chats into the fixed panel; the pure step lives in shared so the writer ratchet stays flat. */
export function applyDefaultChatPanelLayout(
  state: ChatPanelLayout,
  worktreeId: string,
  workspaceMode?: ChatPanelWorkspaceMode
): ChatPanelLayout {
  return separateChatPanelGroups(state, worktreeId, workspaceMode, {
    splitGroup: insertSplitGroup,
    sanitizeRecentTabIds
  })
}

export type ChatPanelCreateRouting = {
  splitTarget: TabSplitTarget | undefined
  contentGroupId: string | undefined
  chatGroupId: string | undefined
  workspaceMode: ChatPanelWorkspaceMode
}

/** Route a new tab beside the fixed panel instead of mixing it; no-op without one. */
export function resolveChatPanelCreateRouting(
  state: ChatPanelLayout & {
    settings?: { workspaceMode?: ChatPanelWorkspaceMode } | null
  },
  worktreeId: string,
  contentType: string,
  init?: { targetGroupId?: string; split?: TabSplitTarget; activate?: boolean }
): ChatPanelCreateRouting {
  const workspaceMode = resolveWorkspaceMode(state.settings)
  const routing: ChatPanelCreateRouting = {
    splitTarget: undefined,
    contentGroupId: undefined,
    chatGroupId: undefined,
    workspaceMode
  }
  const chatGroup = (state.groupsByWorktree[worktreeId] ?? []).find((group) => group.isChatPanel)
  if (!chatGroup || init?.split) {
    return routing
  }
  if (contentType === 'agent-session') {
    routing.chatGroupId = init?.targetGroupId ?? chatGroup.id
    return routing
  }
  const layoutGroupIds = collectTabGroupLayoutGroupIds(state.layoutByWorktree[worktreeId])
  routing.contentGroupId = (state.groupsByWorktree[worktreeId] ?? []).find(
    (group) => !group.isChatPanel && layoutGroupIds.has(group.id)
  )?.id
  if (!routing.contentGroupId) {
    routing.splitTarget = {
      sourceGroupId: init?.targetGroupId ?? chatGroup.id,
      splitDirection: workspaceMode === 'code' ? 'left' : 'right',
      activate: init?.activate ?? true
    }
  }
  return routing
}

/** Code keeps editor tabs center and chat right; Work keeps chat first. */
export function chatPanelSideForMode(mode?: ChatPanelWorkspaceMode): ChatPanelSide {
  return mode === 'code' ? 'second' : 'first'
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
 * collapses the split like any other pane.
 */
export function shouldPinChatPanelColumn(): boolean {
  return false
}
