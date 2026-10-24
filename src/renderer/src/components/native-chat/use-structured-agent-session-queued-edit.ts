import {
  queuedMessageWithEdit,
  queuedEditInput,
  queuedEditSaveHeld
} from '../../../../shared/queued-message-edit'
import {
  queuedEditImagesEditor,
  type QueuedEditImageState,
  type QueuedEditImagesEditor
} from './structured-agent-session-queued-edit-images'
import type { QueuedEditLease } from './structured-agent-session-queued-edit-lease'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'

export type QueuedEditTransport = {
  target: RuntimeClientTarget
  sessionId: string
  capable: boolean
  imagesCapable?: boolean
  write: StructuredAgentSessionWrite
}

export type QueuedEditSelection = {
  from: number
  to: number
  direction: 'forward' | 'backward' | 'none'
}

export type QueuedMessageInlineEditor = {
  selection?: QueuedEditSelection
  select?: (selection: QueuedEditSelection) => void
  messageId: string
  text: string
  acquiring: boolean
  saving: boolean
  canSave: boolean
  change: (text: string) => void
  insertText?: (text: string, from: number, to: number) => boolean
  save: () => void
  cancel: () => void
  images?: QueuedEditImagesEditor
}

export type QueuedEditAttachment = {
  transport: QueuedEditTransport
  messages: readonly AgentSessionQueuedMessage[] | null
  cards: readonly QueuedMessageCard[]
  submissions: readonly AgentJournalSubmission[]
  composerScopeKey: string | undefined
  promptOpen: boolean
}

import { useEffect, useMemo, useContext, useSyncExternalStore } from 'react'
import {
  NativeChatViewIdentity,
  nativeChatViewRetirements,
  createNativeChatReturnField,
  useNativeChatReturnRef
} from './native-chat-view-state-memory'
import { createQueuedEditOwner } from './structured-agent-session-queued-edit-owner'

const owners = new Map<string, ReturnType<typeof createQueuedEditOwner>>()
nativeChatViewRetirements.add((key) => {
  owners.get(key)?.retire()
  owners.delete(key)
})
const editOwner = createNativeChatReturnField<ReturnType<typeof createQueuedEditOwner>>()
export function useStructuredAgentSessionQueuedEdit(args: QueuedEditAttachment) {
  const cell = useNativeChatReturnRef(
    editOwner,
    () => createQueuedEditOwner(args),
    `${args.transport.target.kind === 'local' ? 'local' : args.transport.target.environmentId}:${args.transport.sessionId}:${args.composerScopeKey ?? ''}`
  )
  const owner = cell.current
  const key = useContext(NativeChatViewIdentity)
  useEffect(() => {
    if (key !== null) {
      owners.set(key, owner)
    }
    return () => {
      if (key === null) {
        owner.retire()
      }
    }
  }, [key, owner])
  useEffect(() => {
    owner.attach(args)
  }, [owner, args])
  useEffect(() => () => owner.detach(), [owner])
  const editor = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  return useMemo(
    () => ({ editor, begin: owner.begin, capable: args.transport.capable }),
    [editor, owner, args.transport.capable]
  )
}

export type Edit = QueuedEditImageState & {
  selection?: QueuedEditSelection
  scope: string
  messageId: string
  baseFingerprint: string
  acquiring: boolean
  saving: boolean
  lease: QueuedEditLease
}

export function queuedEditProjection(
  active: { current: Edit | null },
  shown: Edit | null,
  imagesCapable: boolean,
  change: (text: string) => void,
  save: () => Promise<void>,
  close: () => void,
  render: (edit: Edit) => void
): QueuedMessageInlineEditor | undefined {
  const identity = active.current
  const typed =
    shown && queuedMessageWithEdit(shown.body, queuedEditInput(shown.body, shown, imagesCapable))
  return shown && typed
    ? {
        get selection() {
          return identity?.selection
        },
        select: (selection) => {
          if (active.current === identity && identity) {
            identity.selection = selection
          }
        },
        messageId: shown.messageId,
        text: shown.text,
        acquiring: shown.acquiring,
        saving: shown.saving,
        canSave: typed.ok && !queuedEditSaveHeld(shown.body, shown, imagesCapable),
        ...(imagesCapable ? { images: queuedEditImagesEditor(shown, typed) } : {}),
        change,
        insertText: (text, from, to) => {
          const edit = active.current
          if (!edit || edit !== identity || edit.acquiring || edit.saving) {
            return false
          }
          edit.text = edit.text.slice(0, from) + text + edit.text.slice(to)
          render(edit)
          return true
        },
        save: () => void save(),
        cancel: close
      }
    : undefined
}
