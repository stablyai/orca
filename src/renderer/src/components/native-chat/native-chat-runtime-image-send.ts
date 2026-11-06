import { sendNativeChatObservedWrites } from './native-chat-observed-send'
import {
  AGENT_IMAGE_ATTACHMENT_SETTLE_MS,
  agentImageAttachmentPastes
} from '../../../../shared/agent-image-attachment-paste'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat/input/native-chat-answer-stepping'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat/input/native-chat-paste-bytes'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'

export function sendNativeChatMessageWithImageAttachments(
  agent: AgentType,
  ptyId: string,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(ptyId, text, options)
  }
  const trimmedText = text.trim()
  if (options?.onWriteRejected) {
    const writes = agentImageAttachmentPastes(agent, imagePaths, trimmedText.length > 0).map(
      (data) => ({ data, delayBeforeMs: 0 })
    )
    if (trimmedText) {
      writes.push({
        data: buildNativeChatPasteBytes(text),
        delayBeforeMs: AGENT_IMAGE_ATTACHMENT_SETTLE_MS
      })
    }
    writes.push({ data: NATIVE_CHAT_SUBMIT, delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS })
    return sendNativeChatObservedWrites(ptyId, writes, options)
  }
  const durationMs =
    (trimmedText.length > 0
      ? AGENT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options)
  return enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted, markWriteStarted }) => {
      if (isCancelled()) {
        return
      }
      clearThenWrite(
        ptyId,
        options,
        delay,
        () => {
          if (isCancelled()) {
            return
          }
          markWriteStarted()
          for (const payload of agentImageAttachmentPastes(
            agent,
            imagePaths,
            trimmedText.length > 0
          )) {
            sendRuntimePtyInput(ptyId, payload, 'driving')
          }
          if (trimmedText.length > 0) {
            delay(AGENT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
              sendRuntimePtyInput(ptyId, buildNativeChatPasteBytes(text), 'driving')
              delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
                sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
                markSubmitted()
              })
            })
            return
          }
          delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
            sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
            markSubmitted()
          })
        },
        markSubmitted
      )
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options)
    }
  )
}
