import {
  sendNativeChatObservedWrites,
  type NativeChatObservedWrite
} from './native-chat-observed-send'
import {
  agentImagePasteWrites,
  getAgentImageHandling
} from '../../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { agentImagePastePath } from '../../../../../../../shared/native-chat/input/composer/agent-image-paste-path'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '../../../../../../../shared/terminal/input/terminal-bracketed-paste-text'
import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../../../../shared/native-chat/input/questions/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../../../../shared/native-chat/input/composer/native-chat-paste-bytes'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import { afterNativeChatPasteLands, readNativeChatInputLine } from './native-chat-paste-landed'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

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
    const writes: NativeChatObservedWrite[] = agentImagePasteWrites(
      agent,
      imagePaths.map((path) => buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))),
      trimmedText.length > 0
    ).map((data) => ({ data, delayBeforeMs: 0 }))
    const mentions = typedImageMentions(agent, writes)
    if (trimmedText) {
      writes.push({
        data: buildNativeChatPasteBytes(text),
        delayBeforeMs: NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS
      })
    }
    writes.push({
      data: NATIVE_CHAT_SUBMIT,
      delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS,
      afterPasteOf: mentions + text
    })
    return sendNativeChatObservedWrites(ptyId, writes, options)
  }
  const durationMs =
    (trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
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
          const lineWasEmpty = readNativeChatInputLine(options?.readInputLine) === ''
          const imageWrites = agentImagePasteWrites(
            agent,
            imagePaths.map((path) =>
              buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))
            ),
            trimmedText.length > 0
          )
          const submitAfterPasteLands = (): void =>
            afterNativeChatPasteLands({
              readInputLine: options?.readInputLine,
              lineWasEmpty,
              text:
                typedImageMentions(
                  agent,
                  imageWrites.map((data) => ({ data }))
                ) + text,
              delay,
              submit: () => {
                sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
                markSubmitted()
              }
            })
          for (const payload of imageWrites) {
            sendRuntimePtyInput(ptyId, payload, 'driving')
          }
          if (trimmedText.length > 0) {
            delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
              sendRuntimePtyInput(ptyId, buildNativeChatPasteBytes(text), 'driving')
              delay(NATIVE_CHAT_SUBMIT_DELAY_MS, submitAfterPasteLands)
            })
            return
          }
          delay(NATIVE_CHAT_SUBMIT_DELAY_MS, submitAfterPasteLands)
        },
        () => markSubmitted('not-submitted')
      )
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options)
    }
  )
}

/** Agents without image paste get `@path` mentions, which their input line shows as text. */
function typedImageMentions(agent: AgentType, writes: readonly { data: string }[]): string {
  if (getAgentImageHandling(agent) === 'attachment') {
    return ''
  }
  return writes
    .map((write) => write.data.replace(BRACKETED_PASTE_START, '').replace(BRACKETED_PASTE_END, ''))
    .join('')
}
