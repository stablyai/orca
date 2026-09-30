import { agentImagePasteWrites, formatAgentImagePath } from '../../../../shared/agent-image-paste'
import type { AgentType } from '../../../../shared/agent-status-types'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import { buildNativeChatImagePasteBytes, buildNativeChatPasteBytes } from './native-chat-send'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  scheduleNativeChatSubmit,
  sendNativeChatMessage,
  type NativeChatSendHandle,
  type NativeChatSendOptions
} from './native-chat-runtime-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

export function sendNativeChatMessageWithImageAttachments(
  agent: AgentType,
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
  let firstEnterSent = false
  const durationMs =
    (trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) +
    (options?.submitRetryDelayMs ?? 0) +
    clearConfirmDurationMs(options)
  const submit = (delay: (ms: number, fn: () => void) => void, markSubmitted: () => void): void =>
    scheduleNativeChatSubmit(
      settings,
      ptyId,
      delay,
      markSubmitted,
      () => {
        firstEnterSent = true
      },
      options?.submitRetryDelayMs
    )
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
        for (const payload of agentImagePasteWrites(
          agent,
          imagePaths.map((path) =>
            buildNativeChatImagePasteBytes(formatAgentImagePath(agent, path))
          ),
          trimmedText.length > 0
        )) {
          sendRuntimePtyInput(settings, ptyId, payload, 'driving')
        }
        if (trimmedText.length > 0) {
          delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
            sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text), 'driving')
            submit(delay, markSubmitted)
          })
          return
        }
        submit(delay, markSubmitted)
      })
    },
    {
      onCancelUnsubmitted: () => {
        if (!firstEnterSent) {
          clearUnsubmittedAgentInput(settings, ptyId, options)
        }
      }
    }
  )
}
