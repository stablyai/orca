import { emitNativeChatToggled } from '@/lib/native-chat-telemetry'
import type { AppState } from '../../types'
import type { RuntimeSessionTabChatView } from '../../../../../shared/runtime-session-contracts'
import type { TerminalTabViewMode } from '../../../../../shared/terminal-tab-view-mode'
import { enqueueChatPair, type ChatPairOutboundStore } from '@/runtime/terminal-chat-pair-outbound'
import { findTabAndWorktree } from '../tab-group-state'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'
import { resolveChatPairAuthority } from './terminal-chat-pair-authority'
import { resolveEffectiveChatPair } from './terminal-chat-pair-effective'

/** A terminal tab whose pair lives in the store (this desktop's own, or a host-owned mirror). */
export function findStoreOwnedTerminalTab(state: AppState, unifiedTabId: string) {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, unifiedTabId)
  if (!found || found.tab.contentType !== 'terminal') {
    return null
  }
  const authority = resolveChatPairAuthority(state, found.worktreeId)
  return authority === 'legacy' ? null : { ...found, authority }
}

/** The worktree of a terminal tab whose pair a paired host owns, or null. */
export function findHostOwnedTerminalWorktree(
  state: AppState,
  terminalTabId: string
): string | null {
  const worktreeId = locateTerminalTab(state.tabsByWorktree, terminalTabId)?.worktreeId
  return worktreeId && resolveChatPairAuthority(state, worktreeId) === 'host' ? worktreeId : null
}

/**
 * A pair write on a host-owned tab: the store keeps host truth, the click shows as an overlay and
 * goes out as one fenced write. Returns the pair now shown, or null for an unknown leaf.
 */
export function writeHostOwnedChatPair(
  store: ChatPairOutboundStore,
  worktreeId: string,
  terminalTabId: string,
  request: { leafId: string | null; viewMode: TerminalTabViewMode },
  options?: { userToggle?: boolean }
): RuntimeSessionTabChatView | null {
  const before = resolveEffectiveChatPair(store.getState(), worktreeId, terminalTabId)
  const shown = enqueueChatPair(store, worktreeId, terminalTabId, request)
  if (!shown) {
    return null
  }
  const from = before.viewMode === 'chat' ? 'chat' : 'terminal'
  const to = shown.viewMode === 'chat' ? 'chat' : 'terminal'
  if (options?.userToggle && from !== to) {
    const agent = locateTerminalTab(store.getState().tabsByWorktree, terminalTabId)?.tab.launchAgent
    emitNativeChatToggled({ from, to, agent: agent ?? null })
  }
  return { viewMode: shown.viewMode ?? null, chatLeafId: shown.chatLeafId ?? null }
}
