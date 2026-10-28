import type { QueuedEditLeaseLoss } from '../../../../shared/queued-message-edit-lease'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { queuedMessageWithEdit } from '../../../../shared/queued-message-edit'
import {
  nativeChatQueuedEditInput,
  nativeChatQueuedEditHeld,
  handBackNativeChatQueuedEdit,
  type NativeChatQueuedEditDraft
} from './native-chat-queued-edit-draft'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { promptMarkersToImageReferences } from '../../../../shared/native-chat-image-transcript-markers'
import { nativeChatImageRowIds } from './native-chat-composer-image-references'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { subscribeToNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { QueuedEditLease } from './structured-agent-session-queued-edit-lease'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'

export type QueuedEditTransport = {
  target: RuntimeClientTarget
  sessionId: string
  /** The host advertises `agent-session.queued-message-edit.v1`; without it there is no Edit. */
  capable: boolean
  /** The host advertises `agent-session.queued-message-image-edit.v1`: Save may replace images. */
  imagesCapable?: boolean
  skillsCapable?: boolean
  reorderCapable?: boolean
  write: StructuredAgentSessionWrite
}

export type QueuedMessageInlineEditor = {
  messageId: string
  draftScopeKey: string
  text: string
  change: (text: string) => void
  acquiring: boolean
  saving: boolean
  canSave: boolean
  imagesCapable: boolean
  save: () => void
  cancel: () => void
}

export type NativeChatQueuedEditAttempt = {
  phase: 'pending' | 'unknown'
  fingerprint: string
  expected: string
  body: AgentJournalMessageItem
  draft: NativeChatComposerDraft
  key: string
}
export function nativeChatQueuedEditSaving(edit: NativeChatQueuedEditSession): boolean {
  return edit.attempt?.phase === 'pending'
}

export type NativeChatQueuedEditSession = NativeChatQueuedEditDraft & {
  scope: string
  sessionId: string
  messageId: string
  /** The body Save expects to replace; fixed for the edit, so a newer text is never overwritten. */
  baseFingerprint: string
  acquiring: boolean
  attempt?: NativeChatQueuedEditAttempt
  uncertain: boolean
  leaseLoss?: QueuedEditLeaseLoss
  closed: boolean
  pendingClose: boolean
  view: {
    messages: readonly AgentSessionQueuedMessage[] | null
    cards: readonly QueuedMessageCard[]
    submissions: readonly AgentJournalSubmission[]
    promptOpen: boolean
  }
  lease: QueuedEditLease
}

export function useNativeChatQueuedEditLifetime({
  scope,
  shownScope,
  active,
  reopen,
  close,
  render
}: {
  scope: string
  shownScope: string | undefined
  active: { current: NativeChatQueuedEditSession | null }
  reopen: { current: { scope: string; messageId: string; stale: string } | null }
  close: (edit?: NativeChatQueuedEditSession | null) => void
  render: (edit: NativeChatQueuedEditSession | null) => void
}) {
  // On chat/host/composer changes, unmount or reload, hand unsaved typing back to its original chat.
  useEffect(() => {
    const handOff = (): void => {
      const edit = active.current
      active.current = null
      reopen.current = null
      if (!edit) {
        return
      }
      if (nativeChatQueuedEditSaving(edit)) {
        edit.pendingClose = true
        return
      }
      if (handBackNativeChatQueuedEdit(edit, edit.uncertain)) {
        toast.error(
          translate(
            'components.native-chat.queuedMessages.editReturned',
            'Your edit is in the chat box.'
          )
        )
      }
      close(edit)
    }
    window.addEventListener('pagehide', handOff)
    return () => {
      window.removeEventListener('pagehide', handOff)
      handOff()
    }
  }, [scope, close, active, reopen])

  useEffect(() => {
    if (!shownScope) {
      return
    }
    const update = (): void => {
      if (active.current) {
        render(active.current)
      }
    }
    const unsubscribe = subscribeToNativeChatComposerDraft(shownScope, update)
    const unpending = subscribeToNativeChatPendingAttachments(shownScope, update)
    return () => {
      unsubscribe()
      unpending()
    }
  }, [shownScope, render, active])
}

export function changeNativeChatQueuedEditText(
  edit: NativeChatQueuedEditSession,
  text: string
): void {
  if (!edit.acquiring && !nativeChatQueuedEditSaving(edit)) {
    updateNativeChatComposerDraft(
      edit.scopeKey,
      {
        text: promptMarkersToImageReferences(text, nativeChatImageRowIds(edit.scopeKey)),
        document: undefined
      },
      'immediate'
    )
  }
}

export type StructuredQueuedEditArgs = {
  transport: QueuedEditTransport
  /** The host's published cards, for each card's full body. */
  messages: readonly AgentSessionQueuedMessage[] | null
  /** The cards this pane shows; a card that leaves them has left the queue. */
  cards: readonly QueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
  composerScopeKey: string | undefined
  /** A question or approval holds the chat box's place. */
  promptOpen: boolean
}

export function nativeChatQueuedEditEditor(
  shown: NativeChatQueuedEditSession | null,
  scope: string,
  imagesCapable: boolean,
  skillsCapable: boolean,
  save: () => void,
  cancel: () => void
): QueuedMessageInlineEditor | undefined {
  const typed =
    shown &&
    queuedMessageWithEdit(
      shown.body,
      nativeChatQueuedEditInput(shown, imagesCapable, skillsCapable)
    )
  const editor: QueuedMessageInlineEditor | undefined =
    shown && typed && shown.scope === scope
      ? {
          messageId: shown.messageId,
          draftScopeKey: shown.scopeKey,
          text: readNativeChatComposerDraft(shown.scopeKey).text,
          change: (text) => changeNativeChatQueuedEditText(shown, text),
          imagesCapable,
          acquiring: shown.acquiring,
          saving: nativeChatQueuedEditSaving(shown),
          canSave: typed.ok && !nativeChatQueuedEditHeld(shown, imagesCapable),
          save,
          cancel
        }
      : undefined
  return editor
}
