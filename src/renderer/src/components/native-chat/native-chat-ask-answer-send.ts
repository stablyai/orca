import {
  runtimeNativeChatPtyWriter,
  type NativeChatPtyWriter,
  type NativeChatRuntimeSettings
} from './native-chat-pty-writer'
import type { AskAnswerKeyGroup } from './native-chat-interactive-prompt'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import { buildNativeChatPasteBytes } from './native-chat-send'

/** Sends selector keystroke groups at the pace agent TUIs can consume. */
export function sendNativeChatAskAnswer(
  settings: NativeChatRuntimeSettings,
  ptyId: string,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void,
  writer: NativeChatPtyWriter = runtimeNativeChatPtyWriter
) {
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
          verifiedWrites.push(writer.writeAccepted(settings, ptyId, bytes).catch(() => false))
        } else {
          writer.write(settings, ptyId, bytes)
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
