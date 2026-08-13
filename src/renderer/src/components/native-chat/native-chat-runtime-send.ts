import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'
import { runtimeNativeChatPtyWriter, type NativeChatPtyWriter } from './native-chat-pty-writer'
import {
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  sendVerifiedNativeChatMessage,
  sendVerifiedNativeChatMessageWithImages
} from './native-chat-verified-send'
export { sendNativeChatAskAnswer } from './native-chat-ask-answer-send'
export { sendNativeChatTypedCommand, typeNativeChatCommand } from './native-chat-command-send'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT } from './native-chat-send'
export { NATIVE_CHAT_CLEAR_CONFIRM_MS, NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS }
export { resetNativeChatPtySendQueuesForTests }

export type NativeChatSendOptions = {
  /** Bytes that empty the agent's input line. Defaults to a single Ctrl+U. */
  clearInput?: string
  /**
   * Observed check that the input line is now empty.
   * Supplied only for launch-draft replacement; when it reports "not cleared"
   * the send widens to a maximal burst before writing the body rather than
   * pasting on top of residue.
   */
  confirmCleared?: () => boolean
  /** Alternate authorized write lane for secondary renderer surfaces. */
  writer?: NativeChatPtyWriter
}

export type NativeChatSendHandle = {
  cancel: () => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
  /** Present when the writer requires asynchronous proof through a secondary renderer. */
  delivered?: Promise<boolean>
}

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

// One Ctrl+U clears one logical line; launch-draft callers supply the measured 2N-1 burst.
function clearUnsubmittedAgentInput(
  settings: RuntimeSettings,
  ptyId: string,
  options?: NativeChatSendOptions
): void {
  ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
    settings,
    ptyId,
    options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
  )
}

/** Clears the TUI line, widening the clear burst when a launch draft remains visible. */
function clearThenWrite(
  settings: RuntimeSettings,
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void
): void {
  clearUnsubmittedAgentInput(settings, ptyId, options)
  const confirmCleared = options?.confirmCleared
  if (!confirmCleared) {
    writeBody()
    return
  }
  delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, () => {
    let cleared = false
    try {
      cleared = confirmCleared()
    } catch {
      // An unreadable terminal is unconfirmed; the maximal clear remains safe.
    }
    if (!cleared) {
      ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
        settings,
        ptyId,
        AGENT_TUI_CLEAR_INPUT_MAX
      )
    }
    writeBody()
  })
}

/** Extra time a send needs when it stops to confirm the clear before the body. */
function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}

/**
 * Chat message path:
 *   1. clear any unsubmitted TUI line
 *   2. write framed body
 *   3. delayed Enter (separate write — same-write CR can be swallowed by paste)
 *
 * Serialized per PTY so rapid sends cannot glue before Enter.
 */
export function sendNativeChatMessage(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  const writer = options?.writer ?? runtimeNativeChatPtyWriter
  if (writer.requiresWriteAcceptance) {
    return sendVerifiedNativeChatMessage(settings, ptyId, text, { ...options, writer })
  }
  return enqueueNativeChatPtySend(
    ptyId,
    NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options),
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        return
      }
      clearThenWrite(settings, ptyId, options, delay, () => {
        if (isCancelled()) {
          return
        }
        ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
          settings,
          ptyId,
          buildNativeChatPasteBytes(text)
        )
        // Schedule from the actual body write: an overdue clear-confirm callback
        // must not collapse the required body-to-Enter gap after a renderer stall.
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
            settings,
            ptyId,
            NATIVE_CHAT_SUBMIT
          )
          markSubmitted()
        })
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options)
    }
  )
}

function waitForNativeChatSubmit(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (completed: boolean): void => {
      if (timer === null) {
        return
      }
      clearTimeout(timer)
      timer = null
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    timer = setTimeout(() => finish(true), NATIVE_CHAT_SUBMIT_DELAY_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Session-option / slash command path (model switch, /effort, …).
 *
 * Does not pre-clear the line (model-switch confirmation watches the PTY).
 * Cancels any in-flight chat clear/body/Enter on this PTY first so a delayed
 * chat Enter cannot dismiss Claude's "Switch model?" dialog.
 */
export async function sendNativeChatMessageVerified(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  signal?: AbortSignal,
  writer: NativeChatPtyWriter = runtimeNativeChatPtyWriter
): Promise<boolean> {
  // Why: chat sends hold a delayed Enter for 500ms. Opening the model picker in
  // that window used to let that Enter hit Claude's confirmation UI, so
  // verification timed out with "Could not verify the model change".
  cancelNativeChatPtySends(ptyId)
  await waitForNativeChatPtyIdle(ptyId)
  if (signal?.aborted) {
    return false
  }

  // Why: option commands await remote/SSH acceptance so the Enter cannot race
  // ahead of the body while a model-change observer is already armed.
  const bodyAccepted = await writer.writeAccepted(settings, ptyId, buildNativeChatPasteBytes(text))
  if (!bodyAccepted || signal?.aborted || !(await waitForNativeChatSubmit(signal))) {
    return false
  }
  return writer.writeAccepted(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

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
  const writer = options?.writer ?? runtimeNativeChatPtyWriter
  if (writer.requiresWriteAcceptance) {
    return sendVerifiedNativeChatMessageWithImages(settings, ptyId, text, imagePaths, {
      ...options,
      writer
    })
  }
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
        for (const imagePath of imagePaths) {
          ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
            settings,
            ptyId,
            buildNativeChatImagePasteBytes(imagePath)
          )
        }
        if (trimmedText.length > 0) {
          delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
            ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
              settings,
              ptyId,
              buildNativeChatPasteBytes(text)
            )
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
              ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
                settings,
                ptyId,
                NATIVE_CHAT_SUBMIT
              )
              markSubmitted()
            })
          })
          return
        }
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          ;(options?.writer ?? runtimeNativeChatPtyWriter).write(
            settings,
            ptyId,
            NATIVE_CHAT_SUBMIT
          )
          markSubmitted()
        })
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options)
    }
  )
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(
  settings: RuntimeSettings,
  ptyId: string,
  writer: NativeChatPtyWriter = runtimeNativeChatPtyWriter
): void {
  writer.write(settings, ptyId, NATIVE_CHAT_SUBMIT)
}
