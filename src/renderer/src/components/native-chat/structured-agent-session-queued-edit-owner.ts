import { queuedEditProjection } from './use-structured-agent-session-queued-edit'
import type { QueuedEditAttachment, Edit } from './use-structured-agent-session-queued-edit'

import { toast } from 'sonner'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import {
  queuedEditDirty,
  queuedEditInput,
  queuedEditSaveHeld,
  queuedMessageEditableText,
  queuedMessageWithEdit
} from '../../../../shared/queued-message-edit'
import { queuedEditChangedNotice, queuedEditNotice } from './queued-message-edit-notices'
import {
  handOffQueuedEdit,
  queuedEditImageFields,
  releaseQueuedEditImages
} from './structured-agent-session-queued-edit-images'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import { startQueuedEditLease } from './structured-agent-session-queued-edit-lease'
import {
  queuedCardOnScreen,
  queuedEditStanding
} from './structured-agent-session-queued-edit-standing'

export function createQueuedEditOwner(initial: QueuedEditAttachment) {
  let args = initial
  const listeners = new Set<() => void>()
  const { transport, composerScopeKey } = initial
  const { messages, cards, submissions, promptOpen } = initial
  const { target, sessionId } = transport
  let imagesCapable = transport.imagesCapable === true
  const scope = `${structuredAgentSessionHostKey(target)}:${sessionId}:${composerScopeKey ?? ''}`
  const active: { current: Edit | null } = { current: null }
  let shown: Edit | null = null
  const setShown = (next: Edit | null) => {
    shown = next
    publish()
  }
  const reopen: { current: { scope: string; messageId: string; stale: string } | null } = {
    current: null
  }
  const latest = { current: { messages, cards, submissions, promptOpen } }
  const render = (edit: Edit | null) => {
    active.current = edit
    setShown(edit ? { ...edit } : null)
  }
  const close = () => {
    const edit = active.current
    render(null)
    window.removeEventListener('pagehide', retire)
    edit?.lease.end()
    if (edit) {
      releaseQueuedEditImages(edit)
    }
  }
  const gone = (edit: Edit) => {
    if (active.current !== edit) {
      return
    }
    if (queuedEditDirty(edit.body, edit) && handOffQueuedEdit(edit)) {
      toast.error(queuedEditNotice(latest.current.promptOpen ? 'editGonePrompt' : 'editGone'))
    }
    close()
  }
  const retire = (): void => {
    const edit = active.current
    reopen.current = null
    if (edit && queuedEditDirty(edit.body, edit)) {
      handOffQueuedEdit(edit)
    }
    close()
    window.removeEventListener('pagehide', retire)
  }
  const begin = async (messageId: string): Promise<void> => {
    reopen.current = null
    if (active.current || !args.transport.capable || !composerScopeKey) {
      return
    }
    const message = args.messages?.find((entry) => entry.messageId === messageId)
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
      text,
      ...queuedEditImageFields(
        message.body,
        () => edit,
        () => isOpen(active, edit),
        () => render(edit)
      ),
      baseFingerprint,
      acquiring: true,
      saving: false,
      lease
    }
    window.addEventListener('pagehide', retire)
    render(edit)
    const answer = await lease.acquired.catch(() => null)
    if (!isOpen(active, edit)) {
      return
    }
    if (answer?.status === 'gone' || answer?.status === 'changed') {
      close()
    } else if (answer?.status === 'not-editable') {
      toast.error(queuedEditNotice('editFailed'))
      close()
    } else {
      edit.acquiring = false
      render(edit)
    }
  }
  const change = (text: string) => {
    const edit = active.current
    if (edit && !edit.acquiring && !edit.saving) {
      edit.text = text
      render(edit)
    }
  }
  const save = async () => {
    const edit = active.current
    if (!edit || edit.acquiring || edit.saving) {
      return
    }
    if (!queuedEditDirty(edit.body, edit)) {
      close()
      return
    }
    const input = queuedEditInput(edit.body, edit, imagesCapable)
    const edited = queuedMessageWithEdit(edit.body, input)
    if (!edited.ok || queuedEditSaveHeld(edit.body, edit, imagesCapable)) {
      return
    }
    edit.saving = true
    render(edit)
    const result = await args.transport.write<AgentSessionQueuedMessageUpdateResult>(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      {
        messageId: edit.messageId,
        expectedBodyFingerprint: edit.baseFingerprint,
        text: input.text,
        ...(input.images ? { images: input.images } : {})
      }
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
        toast.error(queuedEditChangedNotice(handOffQueuedEdit(edit), latest.current.promptOpen))
        reopen.current = { scope, messageId: edit.messageId, stale: edit.baseFingerprint }
        close()
      } else {
        toast.error(queuedEditNotice('editFailed'))
        render(edit)
      }
      return
    }
    const desired = agentSessionSendBodyFingerprint(sessionId, edited.body)
    const standing = queuedEditStanding(latest.current, sessionId, edit.messageId, desired)
    if (standing === 'sent' || standing === 'holds') {
      close()
    } else if (standing === 'gone') {
      gone(edit)
    } else {
      if (standing === 'differs' && result.kind === 'not-done') {
        toast.error(result.notice)
      }
      render(edit)
    }
  }
  const reconcile = () => {
    const { messages, cards, submissions } = args
    const edit = active.current
    if (edit && !edit.saving && messages !== null) {
      const typed = queuedMessageWithEdit(
        edit.body,
        queuedEditInput(edit.body, edit, imagesCapable)
      )
      const desired = typed.ok ? agentSessionSendBodyFingerprint(sessionId, typed.body) : null
      const view = { messages, cards, submissions }
      const standing = queuedEditStanding(view, sessionId, edit.messageId, desired)
      if (standing === 'sent' || (standing === 'holds' && desired !== edit.baseFingerprint)) {
        close()
      } else if (standing === 'gone') {
        gone(edit)
      }
    }
    const pending = reopen.current
    if (!pending || edit || messages === null) {
      return
    }
    const listed = messages.find((entry) => entry.messageId === pending.messageId)
    if (pending.scope !== scope || !listed || !queuedCardOnScreen(cards, pending.messageId)) {
      reopen.current = null
    } else if (agentSessionSendBodyFingerprint(sessionId, listed.body) !== pending.stale) {
      void begin(pending.messageId)
    }
  }
  const getEditor = () =>
    queuedEditProjection(active, shown, imagesCapable, change, save, close, render)
  let snapshot = getEditor()
  const publish = () => {
    snapshot = getEditor()
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach: (next: QueuedEditAttachment) => {
      const changed = imagesCapable !== (next.transport.imagesCapable === true)
      imagesCapable = next.transport.imagesCapable === true
      args = next
      latest.current = {
        messages: next.messages,
        cards: next.cards,
        submissions: next.submissions,
        promptOpen: next.promptOpen
      }
      reconcile()
      if (changed) {
        publish()
      }
    },
    detach: () => {
      args = {
        ...args,
        transport: { ...args.transport, write: async () => ({ kind: 'dropped' }) },
        messages: null,
        cards: [],
        submissions: []
      }
      latest.current = { ...latest.current, messages: null, cards: [], submissions: [] }
    },
    begin,
    retire
  }
}

function isOpen(active: { current: Edit | null }, edit: Edit): boolean {
  return active.current === edit
}
