import type { AppState } from '../types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { terminalLayoutNodeContainsLeaf } from '../../../../shared/native-chat-leaf-ownership'
import { resolveChatPairAuthority } from '../slices/tabs/terminal-chat-pair-authority'
import {
  patchTerminalChatViewMode,
  readTerminalChatViewMode,
  withTerminalChatOwner
} from '../slices/tabs/terminal-chat-pair-state'
import { locateTerminalTab } from './terminal-tab-location'

type LayoutOwnerState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
> &
  Parameters<typeof resolveChatPairAuthority>[0]

function ownerIsSettled(layout: TerminalLayoutSnapshot, owner: string | undefined): boolean {
  return !owner || !layout.root || terminalLayoutNodeContainsLeaf(layout.root, owner)
}

/**
 * The layout lane on a `'local'` tab never chooses the owner: it keeps the stored one, and may
 * only seed a first layout or fill in an owner for a chat that has none. Null means the tab is
 * not local (or unknown), so the incoming owner is stored as before.
 */
export function resolveLocalLayoutChatOwner(
  state: LayoutOwnerState,
  tabId: string,
  incoming: TerminalLayoutSnapshot
): TerminalLayoutSnapshot | null {
  const existing = state.terminalLayoutsByTabId[tabId]
  // Why the fast path: title and geometry churn re-persist the stored owner on every write.
  if (
    incoming.chatLeafId === existing?.chatLeafId &&
    ownerIsSettled(incoming, incoming.chatLeafId)
  ) {
    return null
  }
  const location = locateTerminalTab(state.tabsByWorktree, tabId)
  if (!location || resolveChatPairAuthority(state, location.worktreeId) !== 'local') {
    return null
  }
  const seed =
    incoming.chatLeafId && terminalLayoutNodeContainsLeaf(incoming.root, incoming.chatLeafId)
      ? incoming.chatLeafId
      : undefined
  const canSeed = !existing || readTerminalChatViewMode(state, tabId) === 'chat'
  return withTerminalChatOwner(incoming, existing?.chatLeafId ?? (canSeed ? seed : undefined))
}

/**
 * Desktop's close rule, applied in the same update as the layout write: once the stored owner is
 * no longer in the tree, the tab leaves chat and no sibling inherits it.
 */
export function applyLocalChatOwnerRemoval(
  state: LayoutOwnerState,
  tabId: string,
  stored: TerminalLayoutSnapshot
): { layout: TerminalLayoutSnapshot; viewModePatch: ReturnType<typeof patchTerminalChatViewMode> } {
  const previousOwner = state.terminalLayoutsByTabId[tabId]?.chatLeafId
  const removed =
    previousOwner !== undefined &&
    stored.root !== null &&
    !(stored.chatLeafId && terminalLayoutNodeContainsLeaf(stored.root, stored.chatLeafId))
  if (!removed) {
    return { layout: stored, viewModePatch: {} }
  }
  return {
    layout: withTerminalChatOwner(stored, undefined),
    viewModePatch:
      readTerminalChatViewMode(state, tabId) === 'chat'
        ? patchTerminalChatViewMode(state, tabId, 'terminal')
        : {}
  }
}
