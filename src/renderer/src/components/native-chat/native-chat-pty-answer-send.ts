// The ordinary PTY message seam for an async-question answer, with the outcome the
// runtime write observed: refused → rejected, acknowledgement lost → unknown, any cancel
// before Enter went out (Stop, PTY swap, an option command draining the queue) → rejected,
// and one after Enter went out but before its acknowledgement → unknown.
// Unlike the composer, it never touches the draft, history, or attachments.

import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { nativeChatPtyHeldForOption } from './native-chat-pty-send-queue'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatPtySendOutcome = 'accepted' | 'rejected' | 'unknown'

export function sendNativeChatMessageWithOutcome(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  text: string
): { handle: NativeChatSendHandle; outcome: Promise<NativeChatPtySendOutcome> } | null {
  // Like the composer: a message typed into a model picker would answer the picker.
  if (nativeChatPtyHeldForOption(ptyId)) {
    return null
  }
  let observed: NativeChatPtySendOutcome | null = null
  const handle = sendNativeChatMessage(settings, ptyId, text, {
    onWriteRejected: () => {
      observed ??= 'rejected'
    },
    onWriteUnconfirmed: () => {
      observed ??= 'unknown'
    }
  })
  const submitted = handle.submitted ?? (() => true)
  const settled = handle.settled ?? Promise.resolve()
  const outcome = settled.then(
    (): NativeChatPtySendOutcome => {
      if (submitted()) {
        return observed ?? 'accepted'
      }
      return handle.completingWriteIssued?.() ? 'unknown' : 'rejected'
    },
    (): NativeChatPtySendOutcome => 'unknown'
  )
  return { handle, outcome }
}
