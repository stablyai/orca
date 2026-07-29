// Runtime send for native chat: clear any unsubmitted TUI line, write the framed
// body, then Enter as a SEPARATE delayed pty write. Kept apart from the pure
// byte builders in native-chat-send.ts so those stay IO-free and unit-testable.

import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AskAnswerKeyGroup } from './native-chat-interactive-prompt'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { resetNativeChatPtySendQueuesForTests }

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

// Why: agent TUI composers treat Ctrl+U as kill-to-start-of-line. Chat sends
// start from an empty line so a prior cancelled paste cannot glue onto the next
// prompt. Not used on verified option commands — model-switch confirmation
// observes the PTY and Ctrl+U can miss confirmation markers.
export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'

/** Cancels an in-flight send's pending pty writes (the delayed Enter, and any
 *  later question bodies/Enters). Safe to call after the send completes. */
export type NativeChatSendHandle = {
  cancel: () => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
}

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

function clearUnsubmittedAgentInput(settings: RuntimeSettings, ptyId: string): void {
  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
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
  text: string
): NativeChatSendHandle {
  return enqueueNativeChatPtySend(
    ptyId,
    NATIVE_CHAT_SUBMIT_DELAY_MS,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        return
      }
      clearUnsubmittedAgentInput(settings, ptyId)
      if (isCancelled()) {
        return
      }
      sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text))
      delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
        sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
        markSubmitted()
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId)
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
  signal?: AbortSignal
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
  const bodyAccepted = await sendRuntimePtyInputVerified(
    settings,
    ptyId,
    buildNativeChatPasteBytes(text)
  )
  if (!bodyAccepted || signal?.aborted || !(await waitForNativeChatSubmit(signal))) {
    return false
  }
  return sendRuntimePtyInputVerified(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

export function sendNativeChatMessageWithImageAttachments(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  imagePaths: readonly string[]
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(settings, ptyId, text)
  }
  const trimmedText = text.trim()
  const durationMs =
    trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS
  return enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        return
      }
      clearUnsubmittedAgentInput(settings, ptyId)
      if (isCancelled()) {
        return
      }
      for (const imagePath of imagePaths) {
        sendRuntimePtyInput(settings, ptyId, buildNativeChatImagePasteBytes(imagePath))
      }
      if (trimmedText.length > 0) {
        delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
          sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text))
        })
        delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
          markSubmitted()
        })
        return
      }
      delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
        sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
        markSubmitted()
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId)
    }
  )
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(settings: RuntimeSettings, ptyId: string): void {
  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

/**
 * Answer Claude's AskUserQuestion by writing its keystroke groups (built by
 * `buildAskAnswerKeys`) to the PTY, one group per `NATIVE_CHAT_QUESTION_STEP_MS`
 * step so the arrow-navigate selector applies each before the next.
 */
export function sendNativeChatAskAnswer(
  settings: RuntimeSettings,
  ptyId: string,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  const timers: ReturnType<typeof setTimeout>[] = []
  const verifiedWrites: Promise<boolean>[] = []
  let cancelled = false
  groups.forEach((group, index) => {
    timers.push(
      setTimeout(() => {
        const bytes = 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text)
        if (onSettled) {
          // Why: inference must use the remote host's acceptance result, not
          // the fire-and-forget renderer dispatch result.
          verifiedWrites.push(
            sendRuntimePtyInputVerified(settings, ptyId, bytes).catch(() => false)
          )
        } else {
          sendRuntimePtyInput(settings, ptyId, bytes)
        }
      }, index * NATIVE_CHAT_QUESTION_STEP_MS)
    )
  })
  const settleAfterMs =
    (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
  if (onSettled) {
    // Why: status inference must wait for every paced write and must not run
    // after cancellation or a rejected runtime write.
    timers.push(
      setTimeout(() => {
        void Promise.all(verifiedWrites).then((results) => {
          if (!cancelled) {
            onSettled(results.every(Boolean))
          }
        })
      }, settleAfterMs)
    )
  }
  return {
    cancel: () => {
      cancelled = true
      for (const timer of timers) {
        clearTimeout(timer)
      }
    },
    // Hold the card until the last keystroke has fired and its submit gap passed.
    settleAfterMs
  }
}
