// Runtime send for native chat: clear any unsubmitted TUI line, write the framed
// body, then Enter as a SEPARATE delayed pty write. Kept apart from the pure
// byte builders in native-chat-send.ts so those stay IO-free and unit-testable.

import { sendNativeChatObservedWrites } from './native-chat-observed-send'
import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { AskAnswerKeyGroup } from './native-chat-interactive-prompt'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'
import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../shared/agent-tui-command-typing'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'
import type { NativeChatSendHandle } from './native-chat-send-handle'
export type { NativeChatSendHandle } from './native-chat-send-handle'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { resetNativeChatPtySendQueuesForTests }

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

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
  if (options?.onWriteRejected) {
    return sendNativeChatObservedWrites(
      settings,
      ptyId,
      [
        { data: buildNativeChatPasteBytes(text), delayBeforeMs: 0 },
        { data: NATIVE_CHAT_SUBMIT, delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS }
      ],
      options
    )
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
        sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text), 'driving')
        // Schedule from the actual body write: an overdue clear-confirm callback
        // must not collapse the required body-to-Enter gap after a renderer stall.
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT, 'driving')
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
    buildNativeChatPasteBytes(text),
    'driving'
  )
  if (!bodyAccepted || signal?.aborted || !(await waitForNativeChatSubmit(signal))) {
    return false
  }
  return sendRuntimePtyInputVerified(settings, ptyId, NATIVE_CHAT_SUBMIT, 'driving')
}

/** Types a slash command as individual keys so Codex opens its command palette. */
export async function typeNativeChatCommand(
  settings: RuntimeSettings,
  ptyId: string,
  command: string,
  signal?: AbortSignal
): Promise<boolean> {
  cancelNativeChatPtySends(ptyId)
  await waitForNativeChatPtyIdle(ptyId)
  const outcome = await typeAgentTuiCommand({
    command,
    signal,
    write: async (key) =>
      (await sendRuntimePtyInputVerified(settings, ptyId, key, 'driving')) ? 'accepted' : 'rejected'
  })
  return outcome === 'accepted'
}

/** Queues a typed slash command with composer sends on the same PTY. */
export function sendNativeChatTypedCommand(
  settings: RuntimeSettings,
  ptyId: string,
  command: string
): NativeChatSendHandle {
  const controller = new AbortController()
  return enqueueNativeChatPtySend(
    ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
    ({ isCancelled, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        if (!isCancelled() && outcome !== 'accepted') {
          clearUnsubmittedAgentInput(settings, ptyId)
        }
        markSubmitted()
      }
      void typeAgentTuiCommand({
        command,
        signal: controller.signal,
        write: async (key) => {
          if (isCancelled()) {
            return 'rejected'
          }
          return (await sendRuntimePtyInputVerified(settings, ptyId, key, 'driving'))
            ? 'accepted'
            : 'rejected'
        }
      }).then(finish, () => finish('rejected'))
    },
    {
      onCancelUnsubmitted: () => {
        controller.abort()
        clearUnsubmittedAgentInput(settings, ptyId)
      }
    }
  )
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(settings: RuntimeSettings, ptyId: string): void {
  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT, 'driving')
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
            sendRuntimePtyInputVerified(settings, ptyId, bytes, 'driving').catch(() => false)
          )
        } else {
          sendRuntimePtyInput(settings, ptyId, bytes, 'driving')
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
