import {
  type NativeChatPtySubmissionOutcome,
  enqueueNativeChatPtySend,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'
import { sendNativeChatObservedWrites } from './native-chat-observed-send'
import { afterNativeChatPasteLands, readNativeChatInputLine } from './native-chat-paste-landed'
import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import type { AskAnswerKeyGroup } from '../../../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../../../../shared/native-chat/input/questions/native-chat-answer-stepping'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../../../../shared/native-chat/input/composer/native-chat-paste-bytes'
import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../../../../shared/agent-launch/startup/agent-tui-command-typing'
// Runtime send for native chat: clear any unsubmitted TUI line, write the framed
// body, then Enter as a SEPARATE delayed pty write. Kept apart from the pure
// byte builders in native-chat-send.ts so those stay IO-free and unit-testable.

/** Cancellation suppresses remaining scheduled writes and is safe after completion. */
export type NativeChatSendHandle = {
  cancel: (keepInput?: boolean) => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
  outcome?: Promise<NativeChatPtySubmissionOutcome>
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
        {
          data: NATIVE_CHAT_SUBMIT,
          delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS,
          afterPasteOf: text
        }
      ],
      options
    )
  }
  return enqueueNativeChatPtySend(
    ptyId,
    NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options),
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
          sendRuntimePtyInput(ptyId, buildNativeChatPasteBytes(text), 'driving')
          // Measure the Enter delay from the actual body write so renderer stalls cannot collapse the gap.
          delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () =>
            afterNativeChatPasteLands({
              readInputLine: options?.readInputLine,
              lineWasEmpty,
              text,
              delay,
              submit: () => {
                sendRuntimePtyInput(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
                markSubmitted()
              }
            })
          )
        },
        () => markSubmitted('not-submitted')
      )
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options)
    }
  )
}

/** Callers decide whether queued chat sends are cancelled or waited for first. */
export async function typeNativeChatCommand(
  ptyId: string,
  command: string,
  signal?: AbortSignal
): Promise<boolean> {
  await waitForNativeChatPtyIdle(ptyId)
  const outcome = await typeAgentTuiCommand({
    command,
    signal,
    write: async (key) =>
      (await sendRuntimePtyInputVerified(ptyId, key, 'driving')) ? 'accepted' : 'rejected'
  })
  return outcome === 'accepted'
}

export function sendNativeChatTypedCommand(
  ptyId: string,
  command: string,
  /** A seeded draft's clear, confirmed like a message send's; the command's own Ctrl+U reaches one line. */
  options?: Pick<NativeChatSendOptions, 'clearInput' | 'readInputLine'>
): NativeChatSendHandle {
  const controller = new AbortController()
  return enqueueNativeChatPtySend(
    ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS + clearConfirmDurationMs(options),
    ({ isCancelled, delay, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        if (!isCancelled() && outcome !== 'accepted') {
          clearUnsubmittedAgentInput(ptyId)
        }
        markSubmitted(
          outcome === 'accepted'
            ? 'submitted'
            : outcome === 'unknown'
              ? 'uncertain'
              : 'not-submitted'
        )
      }
      const typeCommand = (): void => {
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
      }
      if (options?.clearInput !== undefined && options.clearInput !== '') {
        clearThenWrite(ptyId, options, delay, typeCommand, () => markSubmitted('not-submitted'))
      } else {
        typeCommand()
      }
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
