import { sendRuntimeAgentPrompt, sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { isWebClientLocation } from '@/lib/web-client-location'
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
  const semanticRemotePrompt =
    options?.agentPrompt === true &&
    trimmedText.length > 0 &&
    isWebClientLocation() &&
    ptyId.startsWith('remote:')
  const durationMs =
    (trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options)
  let resolveAccepted: ((accepted: boolean) => void) | undefined
  const accepted = semanticRemotePrompt
    ? new Promise<boolean>((resolve) => {
        resolveAccepted = resolve
      })
    : undefined
  let acceptanceSettled = false
  const settleAcceptance = (value: boolean): void => {
    if (acceptanceSettled) {
      return
    }
    acceptanceSettled = true
    resolveAccepted?.(value)
  }
  const queued = enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, signal, markSubmitted }) => {
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
            if (semanticRemotePrompt) {
              const semanticPrompt = sendRuntimeAgentPrompt(settings, ptyId, text, signal)
              if (!semanticPrompt) {
                sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text))
                delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
                  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
                  settleAcceptance(true)
                  markSubmitted()
                })
                return
              }
              void semanticPrompt.then(
                (acceptedPrompt) => {
                  settleAcceptance(acceptedPrompt === true)
                  markSubmitted()
                },
                () => {
                  settleAcceptance(false)
                  markSubmitted()
                }
              )
              return
            }
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
  if (accepted) {
    void queued.settled.then(() => settleAcceptance(false))
  }
  return accepted
    ? {
        ...queued,
        accepted,
        cancel: () => {
          queued.cancel()
          settleAcceptance(false)
        }
      }
    : queued
}
