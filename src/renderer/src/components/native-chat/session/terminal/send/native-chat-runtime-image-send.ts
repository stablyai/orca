import {
  prepareAgentImagePaths,
  type AgentImagePreparationOptions
} from '@/runtime/files/agent-image-preparation'
import {
  sendNativeChatObservedWrites,
  type NativeChatObservedWrite
} from './native-chat-observed-send'
import {
  agentImagePasteWrites,
  agentImageDeliveryText,
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
  options?: NativeChatSendOptions & Pick<AgentImagePreparationOptions, 'executionHostId'>
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(ptyId, text, options)
  }
  const preparePaths = async (signal: AbortSignal): Promise<string[]> => {
    const prepared = await prepareAgentImagePaths(ptyId, imagePaths, undefined, {
      signal,
      executionHostId: options?.executionHostId,
      isCurrent: options?.isCurrent
    })
    signal.throwIfAborted()
    options?.onImagesPrepared?.(prepared)
    return prepared
  }
  if (options?.onWriteRejected) {
    const buildWrites = (preparedPaths: readonly string[]): NativeChatObservedWrite[] => {
      const deliveryText = agentImageDeliveryText(text, imagePaths, preparedPaths)
      const writes: NativeChatObservedWrite[] = agentImagePasteWrites(
        agent,
        preparedPaths.map((path) =>
          buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))
        ),
        deliveryText.trim().length > 0
      ).map((data) => ({ data, delayBeforeMs: 0 }))
      const mentions = typedImageMentions(agent, writes)
      if (deliveryText.trim()) {
        writes.push({
          data: buildNativeChatPasteBytes(deliveryText),
          delayBeforeMs: NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS
        })
      }
      writes.push({
        data: NATIVE_CHAT_SUBMIT,
        delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS,
        afterPasteOf: mentions + deliveryText
      })
      return writes
    }
    return sendNativeChatObservedWrites(ptyId, buildWrites(imagePaths), options, async (signal) =>
      buildWrites(await preparePaths(signal))
    )
  }
  const durationMs =
    NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS +
    NATIVE_CHAT_SUBMIT_DELAY_MS +
    clearConfirmDurationMs(options)
  return enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, signal, delay, markSubmitted, markWriteStarted }) => {
      if (isCancelled()) {
        return
      }
      void preparePaths(signal).then(
        (preparedPaths) => {
          const deliveryText = agentImageDeliveryText(text, imagePaths, preparedPaths)
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
                preparedPaths.map((path) =>
                  buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))
                ),
                deliveryText.trim().length > 0
              )
              const rejectSuccessor = (): boolean => {
                if (options?.isCurrent?.() !== false) {
                  return false
                }
                options?.onDeliverySettled?.(false)
                markSubmitted('uncertain')
                return true
              }
              const submitAfterPasteLands = (): void =>
                afterNativeChatPasteLands({
                  readInputLine: options?.readInputLine,
                  lineWasEmpty,
                  text:
                    typedImageMentions(
                      agent,
                      imageWrites.map((data) => ({ data }))
                    ) + deliveryText,
                  delay,
                  submit: () => {
                    if (rejectSuccessor()) {
                      return
                    }
                    sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
                    markSubmitted()
                  }
                })
              for (const payload of imageWrites) {
                sendRuntimePtyInput(ptyId, payload, 'driving')
              }
              if (deliveryText.trim().length > 0) {
                delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
                  if (rejectSuccessor()) {
                    return
                  }
                  sendRuntimePtyInput(ptyId, buildNativeChatPasteBytes(deliveryText), 'driving')
                  delay(NATIVE_CHAT_SUBMIT_DELAY_MS, submitAfterPasteLands)
                })
                return
              }
              delay(NATIVE_CHAT_SUBMIT_DELAY_MS, submitAfterPasteLands)
            },
            () => markSubmitted('not-submitted')
          )
        },
        () => {
          if (isCancelled()) {
            return
          }
          options?.onWriteRejected?.()
          options?.onDeliverySettled?.(false)
          markSubmitted('not-submitted')
        }
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
