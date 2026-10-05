import type { AppState } from '../types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { terminalLayoutNodeContainsLeaf } from '../../../../shared/native-chat-leaf-ownership'
import { pinTerminalChatOwnerOnGrowth } from '../../../../shared/terminal-tab-view-mode'
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
 * The layout lane never chooses the owner of a tab whose pair the store holds. On `'local'` it
 * keeps the stored owner, pins an ownerless single-pane chat to that pane when the tree grows, and
 * otherwise may only seed a first layout or fill in an owner for a chat that has none. On `'host'`
 * it keeps the host's owner verbatim: moves and removals arrive as host snapshots. Null means the
 * incoming owner is stored as before (a `'legacy'` or unknown tab).
 */
export function resolveStoreOwnedLayoutChatOwner(
  state: LayoutOwnerState,
  tabId: string,
  incoming: TerminalLayoutSnapshot
): { layout: TerminalLayoutSnapshot; authority: 'local' | 'host' } | null {
  const existing = state.terminalLayoutsByTabId[tabId]
  const growsOwnerless =
    !existing?.chatLeafId && existing?.root?.type === 'leaf' && incoming.root?.type === 'split'
  // Why the fast path: title and geometry churn re-persist the stored owner on every write.
  if (
    !growsOwnerless &&
    incoming.chatLeafId === existing?.chatLeafId &&
    ownerIsSettled(incoming, incoming.chatLeafId)
  ) {
    return null
  }
  const location = locateTerminalTab(state.tabsByWorktree, tabId)
  const authority = location ? resolveChatPairAuthority(state, location.worktreeId) : 'legacy'
  if (authority === 'legacy') {
    return null
  }
  if (authority === 'host') {
    // Why: the pane stamps its effective owner, which may be an unconfirmed click.
    return { layout: withTerminalChatOwner(incoming, existing?.chatLeafId), authority }
  }
  const seed =
    incoming.chatLeafId && terminalLayoutNodeContainsLeaf(incoming.root, incoming.chatLeafId)
      ? incoming.chatLeafId
      : undefined
  const viewMode = readTerminalChatViewMode(state, tabId)
  // Why before the seed: after a split the pane may stamp the new active leaf, a fresh shell.
  const pinned = pinTerminalChatOwnerOnGrowth({
    viewMode,
    chatLeafId: existing?.chatLeafId,
    priorRoot: existing?.root,
    nextRoot: incoming.root
  })
  const canSeed = !existing || viewMode === 'chat'
  return {
    layout: withTerminalChatOwner(incoming, pinned ?? (canSeed ? seed : undefined)),
    authority
  }
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
