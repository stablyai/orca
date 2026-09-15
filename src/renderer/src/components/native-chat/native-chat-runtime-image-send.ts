import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import { getNativeChatAttachmentForm } from '../../../../shared/native-chat-agent-profiles'
import {
  buildNativeChatAttachmentWrites,
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

/** `agent` picks the attachment form: only agents with a verified image-paste
 *  gesture get a bracketed raw path; the rest get `@path` (see
 *  getNativeChatAttachmentForm). */
export function sendNativeChatMessageWithImageAttachments(
  settings: RuntimeSettings,
  ptyId: string,
  agent: AgentType | null | undefined,
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
        for (const payload of buildNativeChatAttachmentWrites(
          imagePaths,
          getNativeChatAttachmentForm(agent),
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
