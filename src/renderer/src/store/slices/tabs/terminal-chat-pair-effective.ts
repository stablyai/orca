import type { AppState } from '../../types'
import type { TerminalChatPair } from '../../../../../shared/terminal-tab-view-mode'
import { chatPairFromChatView } from '../../../../../shared/chat-pair-pending'
import {
  resolveChatPairAuthority,
  type ChatPairAuthorityState
} from './terminal-chat-pair-authority'
import { readTerminalChatPair } from './terminal-chat-pair-state'

type EffectiveChatPairState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
> &
  ChatPairAuthorityState & {
    pendingChatPairByTabId?: Record<string, TerminalChatPair>
  }

const NO_PENDING_CHAT_PAIRS: Record<string, TerminalChatPair> = {}

/** This desktop's unconfirmed write for a tab, shown only while the host owns the pair. */
export function selectPendingChatPair(
  state: Pick<EffectiveChatPairState, 'pendingChatPairByTabId'> & ChatPairAuthorityState,
  worktreeId: string,
  terminalTabId: string
): TerminalChatPair | undefined {
  const pending = state.pendingChatPairByTabId?.[terminalTabId]
  // Why the authority check last: the overlay map is almost always empty, so the walk is rare.
  if (!pending || resolveChatPairAuthority(state, worktreeId) !== 'host') {
    return undefined
  }
  return pending
}

/** The overlay map for a worktree's tab bar; a shared empty map unless the host owns the pair. */
export function selectPendingChatPairsForWorktree(
  state: Pick<EffectiveChatPairState, 'pendingChatPairByTabId'> & ChatPairAuthorityState,
  worktreeId: string
): Record<string, TerminalChatPair> {
  const pending = state.pendingChatPairByTabId
  if (
    !pending ||
    Object.keys(pending).length === 0 ||
    resolveChatPairAuthority(state, worktreeId) !== 'host'
  ) {
    return NO_PENDING_CHAT_PAIRS
  }
  return pending
}

/** The one read of a terminal tab's pair: the pending overlay on `'host'`, else the stored pair. */
export function resolveEffectiveChatPair(
  state: EffectiveChatPairState,
  worktreeId: string,
  terminalTabId: string
): TerminalChatPair {
  const pending = selectPendingChatPair(state, worktreeId, terminalTabId)
  if (pending) {
    return pending
  }
  const stored = readTerminalChatPair(state, terminalTabId)
  return stored ? chatPairFromChatView(stored) : {}
}
