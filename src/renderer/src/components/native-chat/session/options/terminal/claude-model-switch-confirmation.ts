import { subscribeToPtyData } from '../../../../terminal-pane/pty-transport/delivery/pty-data-sidecar-subscriptions'
import { isRemoteRuntimePtyId } from '../../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import { subscribeToRuntimeTerminalData } from '@/runtime/hosted-terminals/streams/runtime-terminal-data-subscription'
import { NATIVE_CHAT_SUBMIT } from '../../../../../../../shared/native-chat/input/native-chat-paste-bytes'

import {
  createClaudeModelSwitchConfirmationObserver as createConfirmationObserver,
  type SubscribeToData,
  type ClaudeModelSwitchConfirmationObserver
} from '../../../../../../../shared/native-chat/input/native-chat-claude-model-switch-confirmation'

export {
  hasClaudeModelSwitchConfirmation,
  type ClaudeModelSwitchConfirmationObserver
} from '../../../../../../../shared/native-chat/input/native-chat-claude-model-switch-confirmation'

export function createClaudeModelSwitchConfirmationObserver(args: {
  ptyId: string
  expectedModelLabel: string | null
  subscribeToData?: SubscribeToData
  submitConfirmation?: () => boolean | void
  timeoutMs?: number
}): ClaudeModelSwitchConfirmationObserver {
  return createConfirmationObserver({
    expectedModelLabel: args.expectedModelLabel,
    timeoutMs: args.timeoutMs,
    subscribeToData:
      args.subscribeToData ??
      ((watcher) =>
        isRemoteRuntimePtyId(args.ptyId)
          ? subscribeToRuntimeTerminalData(
              args.ptyId,
              `desktop:native-chat-model-switch:${args.ptyId}`,
              watcher,
              { startAtLiveTail: true }
            )
          : subscribeToPtyData(args.ptyId, watcher)),
    submitConfirmation:
      args.submitConfirmation ??
      (() => sendRuntimePtyInput(args.ptyId, NATIVE_CHAT_SUBMIT, 'driving'))
  })
}
