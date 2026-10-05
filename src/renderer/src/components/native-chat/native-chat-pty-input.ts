// The one place native chat writes PTY input, so every write of a composer action carries its
// action and a refused action never reaches the shell through an untagged path.
import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import {
  sendRuntimeChatInput,
  type RuntimeChatInputAction
} from '@/runtime/runtime-chat-input-send'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { createNativeChatInputAction } from '../../../../shared/native-chat-input-action'
import { locateTerminalTab } from '@/store/terminals/terminal-tab-location'
import { hostOwnsChatAgentExit } from '@/store/slices/tabs/terminal-chat-pair-authority'
import { useAppStore } from '../../store'
import { awaitPendingChatPairSettlement } from '@/runtime/terminal-chat-pair-outbound'
import { translate } from '@/i18n/i18n'

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

/** Starts one composer action for the chat in `terminalTabId`; `onRefused` fires at most once. */
export function createNativeChatWriteAction(
  terminalTabId: string,
  onRefused?: RuntimeChatInputAction['onRefused']
): RuntimeChatInputAction {
  const state = useAppStore.getState()
  const worktreeId = locateTerminalTab(state.tabsByWorktree, terminalTabId)?.worktreeId
  const hostGuarded = worktreeId ? hostOwnsChatAgentExit(state, worktreeId) : false
  // Why: a send right after a switch waits for the host to commit it, so the guard never refuses
  // a chat the user just chose; only an answer that commits chat lets the first byte go.
  const pending =
    hostGuarded && worktreeId ? awaitPendingChatPairSettlement(worktreeId, terminalTabId) : null
  return {
    ...createNativeChatInputAction(),
    hostGuarded,
    refused: false,
    ...(pending
      ? {
          ready: pending.then(
            (settlement) => settlement.kind === 'applied' && settlement.pair.viewMode === 'chat'
          )
        }
      : {}),
    ...(onRefused ? { onRefused } : {})
  }
}

/** Fire-and-forget step; false when the action was already refused (nothing is written). */
export function sendNativeChatPtyInput(
  settings: RuntimeSettings,
  ptyId: string,
  data: string,
  action?: RuntimeChatInputAction
): boolean {
  if (!action) {
    return sendRuntimePtyInput(settings, ptyId, data, 'driving')
  }
  if (action.refused) {
    return false
  }
  void sendRuntimeChatInput(settings, ptyId, data, 'driving', action)
  return true
}

/** Acknowledged step: false on refusal; throws when delivery is unknown, like the untagged path. */
export async function sendNativeChatPtyInputVerified(
  settings: RuntimeSettings,
  ptyId: string,
  data: string,
  action?: RuntimeChatInputAction
): Promise<boolean> {
  if (!action) {
    return sendRuntimePtyInputVerified(settings, ptyId, data, 'driving')
  }
  const result = await sendRuntimeChatInput(settings, ptyId, data, 'driving', action)
  if (result.deliveryUnknown) {
    throw new Error('chat_input_delivery_unknown')
  }
  return result.accepted
}

/** The existing "Message not sent" text, for refused composer writes that have no message row. */
export function nativeChatMessageNotSentText(): string {
  return translate('components.native-chat.messageNotSent', 'Message not sent')
}
