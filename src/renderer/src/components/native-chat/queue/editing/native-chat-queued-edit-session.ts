import { useNativeChatPaneLifetimeEffect } from '../../pane/ownership/native-chat-pane-lifetime'
import type {
  QueuedEditLease,
  QueuedEditLeaseLoss
} from '../../../../../../shared/native-chat/input/queued-messages/queued-message-edit-lease'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { queuedMessageWithEdit } from '../../../../../../shared/native-chat/input/queued-messages/queued-message-edit'
import {
  nativeChatQueuedEditInput,
  nativeChatQueuedEditHeld,
  handBackNativeChatQueuedEdit,
  type NativeChatQueuedEditDraft
} from './native-chat-queued-edit-draft'
import type { NativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-storage'
import { promptMarkersToImageReferences } from '../../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { nativeChatImageRowIds } from '../../composer/editor/native-chat-composer-image-references'
import { useCallback, useContext, useEffect } from 'react'
import {
  NativeChatViewTabContext,
  onNativeChatViewTabRelease,
  useNativeChatViewRef,
  useNativeChatViewState
} from '../../pane/ownership/native-chat-view-memory'
import { toast } from 'sonner'
import { queuedEditReturnedNotice } from './queued-message-edit-notices'
import { subscribeToNativeChatPendingAttachments } from '../../attachments/chips/native-chat-pending-attachment-cache'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionQueuedMessage } from '../../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageCard } from '../../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { StructuredAgentSessionWrite } from '../../session/structured/writes/use-structured-agent-session-mutate'

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

/**
 * The open edit, what its editor shows, and a pending reopen, kept with the chat tab: a view released mid-edit
 * returns with the edit still open and its lease still held, as the open edit's own state would in a store.
 */
export function useKeptNativeChatQueuedEdit() {
  const activeRef = useNativeChatViewRef<NativeChatQueuedEditSession | null>('queued-edit', null)
  const [shown, setShown] = useNativeChatViewState<NativeChatQueuedEditSession | null>(
    'queued-edit-shown',
    null
  )
  /** Save answered `changed`: the editor reopens on the newer text once this pane shows it. */
  const reopenRef = useNativeChatViewRef<{
    scope: string
    messageId: string
    stale: string
  } | null>('queued-edit-reopen', null)
  return { activeRef, shown, setShown, reopenRef }
}

// The tab-close hand-back of an edit whose view was released, by the kept edit ref it belongs to.
const keptQueuedEditRelease = new WeakMap<object, () => void>()

/** Ends an edit, handing unsaved typing back to its chat; a Save in flight closes it once it settles. */
function windUpQueuedEdit(
  edit: NativeChatQueuedEditSession,
  close: (edit?: NativeChatQueuedEditSession | null) => void
): void {
  if (nativeChatQueuedEditSaving(edit)) {
    edit.pendingClose = true
    return
  }
  if (handBackNativeChatQueuedEdit(edit, edit.uncertain)) {
    toast.error(queuedEditReturnedNotice())
  }
  close(edit)
}

export function useNativeChatQueuedEditLifetime({
  scope,
  shownScope,
  active: activeRef,
  reopen: reopenRef,
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
  const viewTab = useContext(NativeChatViewTabContext)
  // On chat/host/composer changes, closing the tab or reload, hand unsaved typing back to its original chat. A view
  // released while its tab stays open leaves the edit open, kept with the tab, for the view that replaces it.
  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      const handOff = (): void => {
        const edit = activeRef.current
        if (edit && edit.scope !== scope) {
          return
        }
        activeRef.current = null
        reopenRef.current = null
        if (edit) {
          windUpQueuedEdit(edit, close)
        }
      }
      // A remount takes back an edit its released view left; one from another chat is handed back now.
      keptQueuedEditRelease.get(activeRef)?.()
      keptQueuedEditRelease.delete(activeRef)
      const kept = activeRef.current
      if (kept && kept.scope !== scope) {
        activeRef.current = null
        reopenRef.current = null
        windUpQueuedEdit(kept, close)
        // `close` skips an edit no longer active; the tab's shown editor belonged to it.
        render(null)
      }
      if (reopenRef.current && reopenRef.current.scope !== scope) {
        reopenRef.current = null
      }
      window.addEventListener('pagehide', handOff)
      return () => {
        window.removeEventListener('pagehide', handOff)
        // A reopen waiting on newer queue text is kept like an open edit.
        if (viewTab && (activeRef.current || reopenRef.current)) {
          keptQueuedEditRelease.set(activeRef, onNativeChatViewTabRelease(viewTab, handOff))
        } else {
          handOff()
        }
      }
    }, [scope, close, render, activeRef, reopenRef, viewTab])
  )

  useEffect(() => {
    if (!shownScope) {
      return
    }
    const update = (): void => {
      if (activeRef.current) {
        render(activeRef.current)
      }
    }
    const unsubscribe = subscribeToNativeChatComposerDraft(shownScope, update)
    const unpending = subscribeToNativeChatPendingAttachments(shownScope, update)
    return () => {
      unsubscribe()
      unpending()
    }
  }, [shownScope, render, activeRef])
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
