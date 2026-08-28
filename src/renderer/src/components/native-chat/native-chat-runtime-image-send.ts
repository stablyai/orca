import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { imagePasteWritesFollowedByText } from '../../../../shared/image-paste-following-text'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  sendNativeChatMessage,
  type NativeChatSendHandle,
  type NativeChatSendOptions
} from './native-chat-runtime-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

export function sendNativeChatMessageWithImageAttachments(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(settings, ptyId, text, options)
  }
  const trimmedText = text.trim()
  const durationMs =
    (trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options)
  return enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        return
      }
      clearThenWrite(settings, ptyId, options, delay, () => {
        if (isCancelled()) {
          return
        }
        for (const payload of imagePasteWritesFollowedByText(
          imagePaths.map(buildNativeChatImagePasteBytes),
          trimmedText.length > 0
        )) {
          sendRuntimePtyInput(settings, ptyId, payload)
        }
        if (trimmedText.length > 0) {
          delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
            sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text))
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
              sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
              markSubmitted()
            })
          })
          return
        }
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
          markSubmitted()
        })
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options)
    }
  )
}
