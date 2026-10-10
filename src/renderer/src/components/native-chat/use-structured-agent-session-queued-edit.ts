// Editing one queued card in place, inside the card itself, so it works while a question or an
// approval holds the composer's slot. The host owns the card; this pane holds only the typing,
// an edit lease that keeps automatic delivery off the card, and Save's compare-and-set.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageUpdateResult
} from '../../../../shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import {
  queuedMessageEditableText,
  queuedMessageWithEditedText
} from '../../../../shared/queued-message-text-edit'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { queuedEditNotice } from './queued-message-edit-notices'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import {
  startQueuedEditLease,
  type QueuedEditLease
} from './structured-agent-session-queued-edit-lease'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'

export type QueuedEditTransport = {
  target: RuntimeClientTarget
  sessionId: string
  /** The host advertises `agent-session.queued-message-edit.v1`; without it there is no Edit. */
  capable: boolean
  write: StructuredAgentSessionWrite
}

export type QueuedMessageInlineEditor = {
  messageId: string
  text: string
  /** The host has not answered the lease yet: the field shows the text, read-only. */
  acquiring: boolean
  saving: boolean
  canSave: boolean
  change: (text: string) => void
  save: () => void
  cancel: () => void
}

type Edit = {
  scope: string
  /** The chat box this edit's typing falls back to; the one it started in, never another. */
  draftKey: string
  messageId: string
  body: AgentSessionQueuedMessage['body']
  originalText: string
  text: string
  /** The body Save expects to replace; fixed for the edit, so a newer text is never overwritten. */
  baseFingerprint: string
  acquiring: boolean
  saving: boolean
  lease: QueuedEditLease
}

export function useStructuredAgentSessionQueuedEdit(args: {
  transport: QueuedEditTransport
  /** The host's published cards, for each card's full body. */
  messages: readonly AgentSessionQueuedMessage[] | null
  /** The cards this pane shows; a card that leaves them has left the queue. */
  cards: readonly QueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
  composerScopeKey: string | undefined
  /** A question or approval holds the chat box's place. */
  promptOpen: boolean
}) {
  const { transport, messages, cards, submissions, composerScopeKey, promptOpen } = args
  const { target, sessionId, capable, write } = transport
  const scope = `${structuredAgentSessionHostKey(target)}:${sessionId}:${composerScopeKey ?? ''}`
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  /** Save answered `changed`: the editor reopens on the newer text once this pane shows it. */
  const reopen = useRef<{ scope: string; messageId: string; stale: string } | null>(null)
  const latest = useRef({ messages, cards, submissions, promptOpen })
  useEffect(() => {
    latest.current = { messages, cards, submissions, promptOpen }
  }, [messages, cards, submissions, promptOpen])

  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(() => {
    const edit = active.current
    render(null)
    edit?.lease.end()
  }, [render])
  /** The card left the queue under the editor: typing is never thrown away, it goes to the
   *  chat box, after whatever draft is already there. */
  const gone = useCallback(
    (edit: Edit) => {
      if (active.current !== edit) {
        return
      }
      if (edit.text !== edit.originalText) {
        appendNativeChatDraftCache(edit.draftKey, edit.text)
        toast.error(queuedEditNotice(latest.current.promptOpen ? 'editGonePrompt' : 'editGone'))
      }
      close()
    },
    [close]
  )

  // Another chat, host or composer, the pane going away, or a reload (which unmounts nothing):
  // unsaved typing goes quietly to the chat box of the chat it was typed in.
  useEffect(() => {
    const handOff = (): void => {
      const edit = active.current
      active.current = null
      reopen.current = null
      if (edit && edit.text !== edit.originalText) {
        appendNativeChatDraftCache(edit.draftKey, edit.text)
      }
      edit?.lease.end()
    }
    window.addEventListener('pagehide', handOff)
    return () => {
      window.removeEventListener('pagehide', handOff)
      handOff()
    }
  }, [scope])

  const begin = useCallback(
    async (messageId: string): Promise<void> => {
      // One editor per pane: another card's Edit waits for this one's Save or Cancel.
      reopen.current = null
      if (active.current || !capable || !composerScopeKey) {
        return
      }
      const message = messages?.find((entry) => entry.messageId === messageId)
      const text = message ? queuedMessageEditableText(message.body) : null
      if (!message || text === null) {
        return
      }
      const baseFingerprint = agentSessionSendBodyFingerprint(sessionId, message.body)
      const lease = startQueuedEditLease({
        target,
        sessionId,
        messageId,
        editId: structuredSessionOperationId(),
        expectedBodyFingerprint: baseFingerprint
      })
      const edit: Edit = {
        scope,
        draftKey: composerScopeKey,
        messageId,
        body: message.body,
        originalText: text,
        text,
        baseFingerprint,
        acquiring: true,
        saving: false,
        lease
      }
      render(edit)
      const answer = await lease.acquired.catch(() => null)
      if (!isOpen(active, edit)) {
        return
      }
      if (answer?.status === 'gone' || answer?.status === 'changed') {
        // Sent, removed or edited elsewhere before the edit began: the card shows what happened.
        close()
      } else if (answer?.status === 'not-editable') {
        toast.error(queuedEditNotice('editFailed'))
        close()
      } else {
        // An unanswered lease never gates typing: the lease keeps trying, and Save checks the text.
        edit.acquiring = false
        render(edit)
      }
    },
    [capable, close, composerScopeKey, messages, render, scope, sessionId, target]
  )

  const change = useCallback(
    (text: string) => {
      const edit = active.current
      if (edit && !edit.acquiring && !edit.saving) {
        edit.text = text
        render(edit)
      }
    },
    [render]
  )

  const save = useCallback(async () => {
    const edit = active.current
    if (!edit || edit.acquiring || edit.saving) {
      return
    }
    if (edit.text === edit.originalText) {
      close()
      return
    }
    const body = queuedMessageWithEditedText(edit.body, edit.text)
    if (!body) {
      return
    }
    edit.saving = true
    render(edit)
    const result = await write<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: edit.baseFingerprint, text: edit.text }
    )
    if (!isOpen(active, edit)) {
      return
    }
    edit.saving = false
    if (result.kind === 'done') {
      const { status } = result.value
      if (status === 'updated' || status === 'unchanged') {
        close()
      } else if (status === 'gone') {
        gone(edit)
      } else if (status === 'changed') {
        // Someone else's edit landed first: the typing goes to the chat box, and the editor
        // opens again on the newer text.
        appendNativeChatDraftCache(edit.draftKey, edit.text)
        toast.error(
          queuedEditNotice(latest.current.promptOpen ? 'editChangedPrompt' : 'editChanged')
        )
        reopen.current = { scope, messageId: edit.messageId, stale: edit.baseFingerprint }
        close()
      } else {
        toast.error(queuedEditNotice('editFailed'))
        render(edit)
      }
      return
    }
    // No answer this pane can read (a lost reply, or one dropped for a moved runtime fence, which
    // a text edit does not depend on): the published card says whether this Save landed.
    const listed = latest.current.messages?.find((entry) => entry.messageId === edit.messageId)
    const desired = agentSessionSendBodyFingerprint(sessionId, body)
    if (latest.current.messages === null) {
      render(edit)
    } else if (!listed || !onScreen(latest.current.cards, edit.messageId)) {
      // The card has left: it went out with this Save's text, or before the Save could land.
      if (sentWith(latest.current.submissions, edit.messageId, desired)) {
        close()
      } else {
        gone(edit)
      }
    } else if (agentSessionSendBodyFingerprint(sessionId, listed.body) === desired) {
      close()
    } else {
      // A refusal says why; an unread answer leaves the editor as it was for Save again.
      if (result.kind === 'not-done') {
        toast.error(result.notice)
      }
      render(edit)
    }
  }, [close, gone, render, scope, sessionId, write])

  // Sent or removed elsewhere, or a lapsed lease lost the race to delivery. While a Save is out,
  // its answer decides instead: its own text going out right after it lands is a success.
  // An unloaded list (`null`) proves nothing: a stream that went quiet did not send the card.
  useEffect(() => {
    const edit = active.current
    if (edit && !edit.saving && messages !== null) {
      const typed = queuedMessageWithEditedText(edit.body, edit.text)
      const desired = typed ? agentSessionSendBodyFingerprint(sessionId, typed) : null
      const listed = messages.find((entry) => entry.messageId === edit.messageId)
      if (!listed || !onScreen(cards, edit.messageId)) {
        if (desired !== null && sentWith(submissions, edit.messageId, desired)) {
          close()
        } else {
          gone(edit)
        }
      } else if (
        desired !== edit.baseFingerprint &&
        agentSessionSendBodyFingerprint(sessionId, listed.body) === desired
      ) {
        // The card already holds what is typed, as after a Save whose answer was lost.
        close()
      }
    }
    const pending = reopen.current
    if (!pending || edit || messages === null) {
      return
    }
    const listed = messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== scope || !listed || !onScreen(cards, pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, listed.body) !== pending.stale) {
      void begin(pending.messageId)
    }
  }, [begin, cards, close, gone, messages, scope, sessionId, shown, submissions])

  const editor: QueuedMessageInlineEditor | undefined =
    shown && shown.scope === scope
      ? {
          messageId: shown.messageId,
          text: shown.text,
          acquiring: shown.acquiring,
          saving: shown.saving,
          canSave: queuedMessageWithEditedText(shown.body, shown.text) !== null,
          change,
          save: () => void save(),
          cancel: close
        }
      : undefined
  return { editor, begin, capable }
}

/** A read of the ref, not a narrowing: an await may have closed or replaced the edit. */
function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}

/** The card went out holding exactly this body. */
function sentWith(
  submissions: readonly AgentJournalSubmission[],
  messageId: string,
  fingerprint: string
): boolean {
  return submissions.some(
    (entry) => entry.queuedMessageId === messageId && entry.payloadFingerprint === fingerprint
  )
}

function onScreen(cards: readonly QueuedMessageCard[], messageId: string): boolean {
  return cards.some((card) => card.messageId === messageId)
}
