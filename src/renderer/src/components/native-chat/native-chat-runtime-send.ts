import { sendNativeChatObservedWrites } from './native-chat-observed-send'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import type { AskAnswerKeyGroup } from '../../../../shared/native-chat-ask-answer'
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
} from '../../../../shared/native-chat/input/native-chat-answer-stepping'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat-paste-bytes'
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

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { resetNativeChatPtySendQueuesForTests }

/** Cancellation suppresses remaining scheduled writes and is safe after completion. */
export type NativeChatSendHandle = {
  cancel: (keepInput?: boolean) => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
}

/** Serialize clear/body/delayed Enter per PTY; a CR sharing the paste write can be swallowed. */
export function sendNativeChatMessage(
  ptyId: string,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (options?.onWriteRejected || options?.onDeliverySettled) {
    return sendNativeChatObservedWrites(
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
      clearThenWrite(ptyId, options, delay, () => {
        if (isCancelled()) {
          return
        }
        sendRuntimePtyInput(ptyId, buildNativeChatPasteBytes(text), 'driving')
        // Measure the Enter delay from the actual body write so renderer stalls cannot collapse the gap.
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
          markSubmitted()
        })
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options)
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

/** Cancel and await chat sends before verified commands; delayed Enter or pre-clear could disrupt model confirmation. */
export async function sendNativeChatMessageVerified(
  ptyId: string,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  cancelNativeChatPtySends(ptyId)
  await waitForNativeChatPtyIdle(ptyId)
  if (signal?.aborted) {
    return false
  }

  // Await remote/SSH body acceptance so Enter cannot race it while model-change observers are armed.
  const bodyAccepted = await sendRuntimePtyInputVerified(
    ptyId,
    buildNativeChatPasteBytes(text),
    'driving'
  )
  if (!bodyAccepted || signal?.aborted || !(await waitForNativeChatSubmit(signal))) {
    return false
  }
  return sendRuntimePtyInputVerified(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
}

export async function typeNativeChatCommand(
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
      (await sendRuntimePtyInputVerified(ptyId, key, 'driving')) ? 'accepted' : 'rejected'
  })
  return outcome === 'accepted'
}

export function sendNativeChatTypedCommand(ptyId: string, command: string): NativeChatSendHandle {
  const controller = new AbortController()
  return enqueueNativeChatPtySend(
    ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
    ({ isCancelled, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        if (!isCancelled() && outcome !== 'accepted') {
          clearUnsubmittedAgentInput(ptyId)
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
          return (await sendRuntimePtyInputVerified(ptyId, key, 'driving'))
            ? 'accepted'
            : 'rejected'
        }
      }).then(finish, () => finish('rejected'))
    },
    {
      onCancelUnsubmitted: () => {
        controller.abort()
        clearUnsubmittedAgentInput(ptyId)
      }
    }
  )
}

export function submitNativeChatPrompt(ptyId: string): void {
  sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
}

/** Space AskUserQuestion keystroke groups so the TUI selector applies each before the next. */
export function sendNativeChatAskAnswer(
  ptyId: string,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  return sendNativeChatObservedWrites(
    ptyId,
    groups.map((group, index) => ({
      data: 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text),
      delayBeforeMs: index === 0 ? 0 : NATIVE_CHAT_QUESTION_STEP_MS
    })),
    {
      clearInput: '',
      stopOnUnconfirmed: !!onSettled,
      settleDelayMs: NATIVE_CHAT_SUBMIT_DELAY_MS,
      onDeliverySettled: onSettled
    }
  )
}
