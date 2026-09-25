import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import type { AskAnswerKeyGroup } from './native-chat-interactive-prompt'
import type { NativeChatSendHandle, RuntimeSettings } from './native-chat-runtime-send'
import { buildNativeChatPasteBytes } from './native-chat-send'

/** Deliver one paced answer to an Agent's interactive question. */
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
    settleAfterMs
  }
}
