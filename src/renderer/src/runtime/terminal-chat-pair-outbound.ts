import { toast } from 'sonner'
import type { AppState } from '../store/types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import {
  ChatPairReplyMissingError,
  chatPairFromChatView,
  chatPairsEqual,
  createChatPairPendingWrites,
  type ChatPairPendingWrites,
  type ChatPairSettlement,
  type ChatPairWriteRequest
} from '../../../shared/chat-pair-pending'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { terminalLayoutNodeContainsLeaf } from '../../../shared/native-chat-leaf-ownership'
import { TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR } from '../../../shared/terminal-chat-view-request'
import {
  resolveTerminalChatPairWrite,
  type TerminalChatPair
} from '../../../shared/terminal-tab-view-mode'
import { resolveChatPairAuthority } from '../store/slices/tabs/terminal-chat-pair-authority'
import { resolveEffectiveChatPair } from '../store/slices/tabs/terminal-chat-pair-effective'
import { readTerminalChatPair } from '../store/slices/tabs/terminal-chat-pair-state'

/** The store surface this module needs; passed in so the tabs slice can call it without a cycle. */
export type ChatPairOutboundStore = {
  getState: () => AppState
  setState: (update: (state: AppState) => Partial<AppState> | AppState) => void
}

type ChatPairKey = { worktreeId: string; terminalTabId: string }

let boundStore: ChatPairOutboundStore | null = null
let pendingWrites: ChatPairPendingWrites<ChatPairKey> | null = null

function readStore(): ChatPairOutboundStore {
  if (!boundStore) {
    throw new Error('chat pair outbound used before a store was bound')
  }
  return boundStore
}

function readHostPair(key: ChatPairKey): TerminalChatPair | null {
  const stored = readTerminalChatPair(readStore().getState(), key.terminalTabId)
  return stored ? chatPairFromChatView(stored) : null
}

function showPending(key: ChatPairKey, pair: TerminalChatPair | null): void {
  readStore().setState((state) => {
    const current = state.pendingChatPairByTabId
    if (pair) {
      return { pendingChatPairByTabId: { ...current, [key.terminalTabId]: pair } }
    }
    if (!(key.terminalTabId in current)) {
      return state
    }
    const { [key.terminalTabId]: _retired, ...rest } = current
    return { pendingChatPairByTabId: rest }
  })
}

/** A timeout or lost connection may have delivered the write, so one resend is owed. */
export function isChatPairDeliveryUnknown(error: unknown): boolean {
  return (
    hasRuntimeRpcErrorCode(error, TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR) ||
    isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
  )
}

/** The user's own switch snapped back to the host's view; the write may still have landed when unconfirmed. */
function chatPairFailureMessage(error: unknown): string {
  return isChatPairDeliveryUnknown(error) || error instanceof ChatPairReplyMissingError
    ? translate(
        'auto.runtime.terminalChatPairOutbound.switchUnconfirmed',
        "Couldn't confirm the view switch"
      )
    : translate('auto.runtime.terminalChatPairOutbound.switchFailed', "Couldn't switch view")
}

function getPendingWrites(): ChatPairPendingWrites<ChatPairKey> {
  pendingWrites ??= createChatPairPendingWrites<ChatPairKey>({
    writerId: createBrowserUuid(),
    keyId: (key) => `${key.worktreeId}\0${key.terminalTabId}`,
    readHostPair,
    send: (key, request, write) =>
      import('./web-runtime-chat-pair-write').then(({ setWebRuntimeChatPair }) =>
        setWebRuntimeChatPair({
          worktreeId: key.worktreeId,
          terminalTabId: key.terminalTabId,
          leafId: request.leafId,
          viewMode: request.viewMode,
          chatViewWrite: write
        })
      ),
    isDeliveryUnknown: isChatPairDeliveryUnknown,
    showPending,
    reportFailure: (_key, error) => {
      console.warn(
        '[web-runtime-session] failed to set chat view:',
        error instanceof Error ? error.message : String(error)
      )
      toast.error(chatPairFailureMessage(error))
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every handle comes from setTimeout above.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  return pendingWrites
}

/**
 * The one writer of a host-owned pair on this desktop: shows the predicted pair as an overlay and
 * sends a fenced write. Returns the pair now shown, or null when the addressed leaf is unknown.
 */
export function enqueueChatPair(
  store: ChatPairOutboundStore,
  worktreeId: string,
  terminalTabId: string,
  request: ChatPairWriteRequest
): TerminalChatPair | null {
  boundStore = store
  const state = store.getState()
  const effective = resolveEffectiveChatPair(state, worktreeId, terminalTabId)
  const target = resolveTerminalChatPairWrite({
    current: effective,
    root: state.terminalLayoutsByTabId[terminalTabId]?.root,
    viewMode: request.viewMode,
    leafId: request.leafId
  })
  if (!target) {
    return null
  }
  if (chatPairsEqual(target, effective)) {
    return effective
  }
  getPendingWrites().submit({ worktreeId, terminalTabId }, request, target)
  return target
}

/** The answer to this desktop's pending switch on a tab, or null when none is pending. */
export function awaitPendingChatPairSettlement(
  worktreeId: string,
  terminalTabId: string
): Promise<ChatPairSettlement> | null {
  return pendingWrites?.settled({ worktreeId, terminalTabId }) ?? null
}

/**
 * Re-derives every pending entry against the store after a host snapshot lands: entries whose
 * worktree stopped being host-owned, whose tab left, or whose leaf left the tree are dropped.
 */
export function reconcilePendingChatPairs(): void {
  if (!pendingWrites || !boundStore) {
    return
  }
  const keys = pendingWrites.pendingKeys()
  if (keys.length === 0) {
    return
  }
  const state = boundStore.getState()
  for (const key of keys) {
    const owner = pendingWrites.pendingPair(key)?.chatLeafId
    const layout = state.terminalLayoutsByTabId[key.terminalTabId]
    const outOfScope =
      resolveChatPairAuthority(state, key.worktreeId) !== 'host' ||
      !readTerminalChatPair(state, key.terminalTabId) ||
      (owner !== undefined && !terminalLayoutNodeContainsLeaf(layout?.root, owner))
    if (outOfScope) {
      pendingWrites.drop(key)
    } else {
      pendingWrites.hostPairChanged(key)
    }
  }
}

/** Test seam: forgets the writer, its entries and the bound store. */
export function resetChatPairOutboundForTests(): void {
  pendingWrites = null
  boundStore = null
}
