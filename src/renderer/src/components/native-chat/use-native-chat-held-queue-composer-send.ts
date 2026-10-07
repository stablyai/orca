// A message sent while the queue is held asks first whether to clear the cards, which would
// otherwise wait behind it. A host command is not a message and sends as it is.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  isNativeChatStructuredHostCommand,
  useNativeChatStructuredComposerSend,
  type NativeChatStructuredComposerSend,
  type UseNativeChatStructuredComposerSendArgs
} from './use-native-chat-structured-composer-send'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import type { NativeChatQueueHold } from './native-chat-composer-types'
import type { NativeChatQueueResume } from './native-chat-composer-primary-action'

type StructuredComposerSend = (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[]
) => void

/** The confirmation as the dialog shows it; kept after it closes so the closing frame still reads. */
export type NativeChatQueueSendConfirm = {
  open: boolean
  /** The cards waiting when it opened. */
  count: number
  /** Delete every card, then send; a failed delete sends nothing. */
  clearQueue: () => void
  /** Send and keep the cards: the message's turn lifts the pause, so they follow it. */
  sendMessage: () => void
  /** Send nothing; the draft and its attachments stay in the composer. */
  dismiss: () => void
}

type PendingSend = {
  text: string
  attachments: readonly NativeChatComposerImageAttachment[] | undefined
  /** The hold it was asked under: the question stands only while that hold does. */
  hold: NativeChatQueueHold
  /** The draft as it was when the message was asked for. */
  sentFrom: NativeChatComposerDraft
}

export function useNativeChatHeldQueueComposerSend(args: UseNativeChatStructuredComposerSendArgs): {
  send: StructuredComposerSend
  /** The message field's queue controls: the composer's Resume and the "Send message?" choice. */
  fieldProps: {
    queueResume: NativeChatQueueResume | undefined
    queueSendConfirm: NativeChatQueueSendConfirm | null
  }
} {
  const sendNow = useNativeChatStructuredComposerSend(args)
  const { agent, structuredTransport } = args
  const queueHold = structuredTransport?.queueHold
  const [pending, setPending] = useState<PendingSend | null>(null)
  const [open, setOpen] = useState(false)
  // The send a choice may still take, taken once: the closing dialog stays clickable for its exit
  // animation, and a double-click or a held Enter lands twice before any re-render.
  const untakenRef = useRef<PendingSend | null>(null)
  // A pause lifted under the open dialog (Orca's mail, another client's Resume) voids the choice:
  // nothing is sent, and the draft stays for the next Enter, which then sends as usual.
  const take = useCallback((): PendingSend | null => {
    const taken = untakenRef.current
    untakenRef.current = null
    setOpen(false)
    return taken?.hold === queueHold ? taken : null
  }, [queueHold])
  // Clear queue sends once its deletes settle, through the send of that render.
  const sendNowRef = useRef<NativeChatStructuredComposerSend>(sendNow)
  useLayoutEffect(() => {
    sendNowRef.current = sendNow
  }, [sendNow])
  // From a Clear queue choice until its message has gone out: the draft still holds that message,
  // and sending it again meanwhile would send it twice.
  const clearingRef = useRef(false)

  const send = useCallback<StructuredComposerSend>(
    (text, attachments) => {
      if (clearingRef.current) {
        return
      }
      if (
        queueHold &&
        structuredTransport &&
        !isNativeChatStructuredHostCommand(text, agent, structuredTransport)
      ) {
        const asked = {
          text,
          attachments,
          hold: queueHold,
          sentFrom: readNativeChatComposerDraft(args.draftScopeKey)
        }
        untakenRef.current = asked
        setPending(asked)
        setOpen(true)
        return
      }
      void sendNow(text, attachments)
    },
    [agent, args.draftScopeKey, queueHold, sendNow, structuredTransport]
  )

  const sendMessage = useCallback(() => {
    const taken = take()
    if (taken) {
      void sendNowRef.current(taken.text, taken.attachments, taken.sentFrom)
    }
  }, [take])
  const clearQueue = useCallback(() => {
    const taken = take()
    if (!taken) {
      return
    }
    clearingRef.current = true
    void (async () => {
      try {
        if (await taken.hold.clear()) {
          // Text typed during the deletes stays: the message was taken from what came before.
          await sendNowRef.current(taken.text, taken.attachments, taken.sentFrom)
        }
      } finally {
        clearingRef.current = false
      }
    })()
  }, [take])
  const dismiss = useCallback(() => {
    take()
  }, [take])

  const confirm = pending
    ? {
        open: open && pending.hold === queueHold,
        count: pending.hold.count,
        clearQueue,
        sendMessage,
        dismiss
      }
    : null
  return {
    send,
    fieldProps: { queueResume: structuredTransport?.queueResume, queueSendConfirm: confirm }
  }
}
