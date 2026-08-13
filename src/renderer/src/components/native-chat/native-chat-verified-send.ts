import type { NativeChatPtyWriter, NativeChatRuntimeSettings } from './native-chat-pty-writer'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'

export type VerifiedNativeChatSendOptions = {
  clearInput?: string
  confirmCleared?: () => boolean
  writer: NativeChatPtyWriter
}

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

function waitForStep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearInput(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  options: VerifiedNativeChatSendOptions
): void {
  options.writer.write(settings, ptyId, options.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
}

async function clearThenWrite(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  options: VerifiedNativeChatSendOptions,
  isCancelled: () => boolean,
  writeBody: () => Promise<boolean>
): Promise<boolean> {
  const clearAccepted = await options.writer
    .writeAccepted(settings, ptyId, options.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
    .catch(() => false)
  if (!clearAccepted || isCancelled()) {
    return false
  }
  if (options.confirmCleared) {
    await waitForStep(NATIVE_CHAT_CLEAR_CONFIRM_MS)
    if (isCancelled()) {
      return false
    }
    let cleared = false
    try {
      cleared = options.confirmCleared()
    } catch {
      // An unreadable terminal is unconfirmed; the maximal clear remains safe.
    }
    if (
      !cleared &&
      !(await options.writer
        .writeAccepted(settings, ptyId, AGENT_TUI_CLEAR_INPUT_MAX)
        .catch(() => false))
    ) {
      return false
    }
  }
  return writeBody()
}

function enqueueVerifiedSend(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  durationMs: number,
  options: VerifiedNativeChatSendOptions,
  run: (isCancelled: () => boolean) => Promise<boolean>
) {
  let accepted = false
  const handle = enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, markSubmitted }) => {
      void run(isCancelled)
        .then((delivered) => {
          accepted = delivered && !isCancelled()
        })
        .catch(() => {
          accepted = false
        })
        .finally(markSubmitted)
    },
    { onCancelUnsubmitted: () => clearInput(settings, ptyId, options) }
  )
  return { ...handle, delivered: handle.settled.then(() => accepted) }
}

export function sendVerifiedNativeChatMessage(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  text: string,
  options: VerifiedNativeChatSendOptions
) {
  const durationMs =
    NATIVE_CHAT_SUBMIT_DELAY_MS + (options.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0)
  return enqueueVerifiedSend(settings, ptyId, durationMs, options, (isCancelled) =>
    clearThenWrite(settings, ptyId, options, isCancelled, async () => {
      const bodyAccepted = await options.writer
        .writeAccepted(settings, ptyId, buildNativeChatPasteBytes(text))
        .catch(() => false)
      if (!bodyAccepted || isCancelled()) {
        return false
      }
      await waitForStep(NATIVE_CHAT_SUBMIT_DELAY_MS)
      return (
        !isCancelled() &&
        (await options.writer.writeAccepted(settings, ptyId, NATIVE_CHAT_SUBMIT).catch(() => false))
      )
    })
  )
}

export function sendVerifiedNativeChatMessageWithImages(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  text: string,
  imagePaths: readonly string[],
  options: VerifiedNativeChatSendOptions
) {
  const trimmedText = text.trim()
  const durationMs =
    (trimmedText
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) + (options.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0)
  return enqueueVerifiedSend(settings, ptyId, durationMs, options, (isCancelled) =>
    clearThenWrite(settings, ptyId, options, isCancelled, async () => {
      for (const imagePath of imagePaths) {
        const imageAccepted = await options.writer
          .writeAccepted(settings, ptyId, buildNativeChatImagePasteBytes(imagePath))
          .catch(() => false)
        if (!imageAccepted || isCancelled()) {
          return false
        }
      }
      if (trimmedText) {
        await waitForStep(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)
        if (isCancelled()) {
          return false
        }
        const bodyAccepted = await options.writer
          .writeAccepted(settings, ptyId, buildNativeChatPasteBytes(text))
          .catch(() => false)
        if (!bodyAccepted || isCancelled()) {
          return false
        }
      }
      await waitForStep(NATIVE_CHAT_SUBMIT_DELAY_MS)
      return (
        !isCancelled() &&
        (await options.writer.writeAccepted(settings, ptyId, NATIVE_CHAT_SUBMIT).catch(() => false))
      )
    })
  )
}
