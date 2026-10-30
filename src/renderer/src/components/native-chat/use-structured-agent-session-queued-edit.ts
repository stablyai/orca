import type { QueuedEditLeaseLoss } from '../../../../shared/queued-message-edit-lease'
import { queuedEditPublicationKey } from '../../../../shared/queued-message-edit-publication'
// Edit inside the card while prompts own the composer; host owns durable content, this pane owns typing, a delivery hold lease and compare-and-set Save.

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import {
  queuedCardOnScreen,
  queuedEditChangedNotice,
  queuedMessageEditableText,
  queuedMessageWithEdit
} from '../../../../shared/queued-message-edit'
import { queuedEditNotice } from './queued-message-edit-notices'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit,
  nativeChatQueuedEditDirty,
  nativeChatQueuedEditHeld,
  nativeChatQueuedEditInput
} from './native-chat-queued-edit-draft'
import { nativeChatQueuedEditValueKey } from './native-chat-queued-edit-value'
import { settleNativeChatQueuedEdit } from './native-chat-queued-edit-outcome'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import { startQueuedEditLease } from './structured-agent-session-queued-edit-lease'
import {
  useNativeChatQueuedEditLifetime,
  nativeChatQueuedEditSaving,
  nativeChatQueuedEditEditor
} from './native-chat-queued-edit-session'
import type {
  StructuredQueuedEditArgs,
  NativeChatQueuedEditSession as Edit
} from './native-chat-queued-edit-session'
export type {
  QueuedEditTransport,
  QueuedMessageInlineEditor
} from './native-chat-queued-edit-session'

export function useStructuredAgentSessionQueuedEdit(args: StructuredQueuedEditArgs) {
  const { transport, messages, cards, submissions, composerScopeKey, promptOpen } = args
  const { target, sessionId, capable, write } = transport
  const imagesCapable = transport.imagesCapable === true
  const scope = `${structuredAgentSessionHostKey(target)}:${sessionId}:${composerScopeKey ?? ''}`
  const active = useRef<Edit | null>(null)
  const [shown, setShown] = useState<Edit | null>(null)
  /** Save answered `changed`: the editor reopens on the newer text once this pane shows it. */
  const reopen = useRef<{ scope: string; messageId: string; stale: string } | null>(null)
  const latest = useRef({ messages, cards, submissions, promptOpen })
  useEffect(() => {
    latest.current = { messages, cards, submissions, promptOpen }
    if (active.current?.scope === scope) {
      active.current.view = latest.current
    }
  }, [messages, cards, submissions, promptOpen, scope])

  const render = useCallback((edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }, [])
  const close = useCallback(
    (edit = active.current) => {
      if (!edit || edit.closed) {
        return
      }
      edit.closed = true
      if (active.current === edit) {
        render(null)
      }
      edit.lease.end()
      discardNativeChatQueuedEdit(edit)
    },
    [render]
  )
  /** Return dirty text to its conversation’s composer after existing draft content when the card leaves the queue. */
  const gone = useCallback(
    (edit: Edit) => {
      if (edit.closed) {
        return
      }
      if (handBackNativeChatQueuedEdit(edit, edit.uncertain)) {
        toast.error(queuedEditNotice(edit.view.promptOpen ? 'editGonePrompt' : 'editGone'))
      }
      close(edit)
    },
    [close]
  )

  const receiveLoss = useCallback(
    (edit: Edit, loss: QueuedEditLeaseLoss, observe: (edit: Edit) => void) => {
      if (edit.closed || edit.lease !== loss.lease) {
        return
      }
      edit.leaseLoss = loss
      observe(edit)
    },
    []
  )
  const reacquire = useCallback(
    (edit: Edit, observe: (edit: Edit) => void) => {
      edit.lease.end()
      edit.leaseLoss = undefined
      edit.lease = startQueuedEditLease({
        target,
        sessionId: edit.sessionId,
        messageId: edit.messageId,
        editId: structuredSessionOperationId(),
        expectedBodyFingerprint: edit.baseFingerprint,
        onLost: (loss) => receiveLoss(edit, loss, observe)
      })
    },
    [target, receiveLoss]
  )

  const settle = useCallback(
    function settleResult(
      edit: Edit,
      attempt = edit.attempt,
      result?: Awaited<ReturnType<typeof write<AgentSessionQueuedMessageUpdateResult>>>
    ) {
      if (
        edit.closed ||
        edit.attempt !== attempt ||
        (!result && nativeChatQueuedEditSaving(edit))
      ) {
        return
      }
      if (edit.acquiring && edit.leaseLoss?.lease === edit.lease) {
        if (edit.leaseLoss.status === 'not-editable') {
          toast.error(queuedEditNotice('editFailed'))
        }
        close(edit)
        return
      }
      const outcome = settleNativeChatQueuedEdit(edit, attempt, result)
      if (outcome === 'close') {
        handBackNativeChatQueuedEdit(edit)
        close(edit)
      } else if (outcome === 'rebase') {
        reacquire(edit, settleResult)
        render(edit)
      } else if (outcome === 'gone') {
        gone(edit)
      } else if (outcome === 'changed') {
        toast.error(
          queuedEditNotice(
            queuedEditChangedNotice(handBackNativeChatQueuedEdit(edit, true), edit.view.promptOpen)
          )
        )
        if (!edit.pendingClose) {
          reopen.current = {
            scope: edit.scope,
            messageId: edit.messageId,
            stale: edit.baseFingerprint
          }
        }
        close(edit)
      } else if (edit.pendingClose) {
        gone(edit)
      } else if (active.current === edit && result) {
        if (outcome === 'refused' && result.kind !== 'dropped') {
          toast.error(result.kind === 'not-done' ? result.notice : queuedEditNotice('editFailed'))
        }
        render(edit)
      }
    },
    [close, gone, reacquire, render]
  )

  useNativeChatQueuedEditLifetime({
    scope,
    shownScope: shown?.scopeKey,
    active,
    reopen,
    close,
    render
  })

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
        expectedBodyFingerprint: baseFingerprint,
        onLost: (loss) => receiveLoss(edit, loss, settle)
      })
      const edit: Edit = {
        scope,
        ...createNativeChatQueuedEditDraft(message.body, composerScopeKey),
        messageId,
        body: message.body,
        baseFingerprint,
        acquiring: true,
        uncertain: false,
        sessionId,
        closed: false,
        pendingClose: false,
        view: latest.current,
        lease
      }
      render(edit)
      await lease.acquired.catch(() => null)
      if (!isOpen(active, edit) || edit.lease !== lease) {
        return
      }
      // An unanswered lease never gates typing: the lease keeps trying, and Save checks the text.
      edit.acquiring = false
      render(edit)
    },
    [capable, composerScopeKey, messages, render, scope, sessionId, target, receiveLoss, settle]
  )

  const save = useCallback(async () => {
    const edit = active.current
    if (!edit || edit.acquiring || nativeChatQueuedEditSaving(edit)) {
      return
    }
    if (!nativeChatQueuedEditDirty(edit) && !edit.uncertain && !edit.attempt) {
      handBackNativeChatQueuedEdit(edit)
      close(edit)
      return
    }
    const input = nativeChatQueuedEditInput(edit, imagesCapable, transport.skillsCapable === true)
    const edited = queuedMessageWithEdit(edit.body, input)
    if (!edited.ok || nativeChatQueuedEditHeld(edit, imagesCapable)) {
      return
    }
    const attempt = {
      phase: 'pending' as const,
      expected: edit.baseFingerprint,
      fingerprint: agentSessionSendBodyFingerprint(sessionId, edited.body),
      body: edited.body,
      draft: structuredClone(readNativeChatComposerDraft(edit.scopeKey)),
      key: nativeChatQueuedEditValueKey(edit.scopeKey)
    }
    edit.attempt = attempt
    render(edit)
    const result = await write<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: edit.messageId, expectedBodyFingerprint: attempt.expected, ...input }
    )
    settle(edit, attempt, result)
  }, [close, imagesCapable, render, sessionId, settle, write, transport.skillsCapable])

  const publication = useMemo(
    () => queuedEditPublicationKey({ messages, cards, submissions }, sessionId, shown?.messageId),
    [messages, cards, submissions, sessionId, shown?.messageId]
  )
  const reconcile = useEffectEvent(() => {
    const edit = active.current
    if (edit && !nativeChatQueuedEditSaving(edit) && messages !== null) {
      settle(edit)
    }
  })
  const reopenLatest = useEffectEvent((messageId: string) => void begin(messageId))

  // Let in-flight Save decide delivery races; otherwise reconcile departures, but never infer them from an unloaded list.
  useEffect(() => {
    reconcile()
  }, [publication, scope])

  useEffect(() => {
    const edit = active.current
    const pending = reopen.current
    if (!pending || edit || messages === null) {
      return
    }
    const listed = messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== scope || !listed || !queuedCardOnScreen(cards, pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, listed.body) !== pending.stale) {
      reopenLatest(pending.messageId)
    }
  }, [cards, messages, scope, sessionId, submissions])

  const editor = nativeChatQueuedEditEditor(
    shown,
    scope,
    imagesCapable,
    transport.skillsCapable === true,
    () => void save(),
    () => close()
  )
  return { editor, begin, capable }
}

/** A read of the ref, not a narrowing: an await may have closed or replaced the edit. */
function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}
