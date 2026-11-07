import {
  moveNativeChatStagedFiles,
  reconcileNativeChatStagedDraft
} from './native-chat-draft-attachment-staging'
import { transferNativeChatDraftReturn } from './native-chat-draft-return-products'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { withoutImageReference } from '../../../../shared/native-chat/native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from '../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import {
  queuedEditKeptImages,
  queuedMessageEditableText,
  type QueuedMessageEdit
} from '../../../../shared/queued-message-edit'
import { pickedSkillsInText } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { promptSkillRefs } from './native-chat-prompt-document'
import {
  promptTextContent,
  seedPromptSkillReferences,
  withoutImageReferenceNodes
} from './native-chat-prompt-document-text'
import {
  appendToNativeChatComposerDraft,
  redirectNativeChatEditDraft,
  closeNativeChatEditDraft,
  openNativeChatEditDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  clearNativeChatPendingAttachments,
  moveNativeChatPendingAttachments,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'
import {
  nativeChatPastedTextOperations,
  NATIVE_CHAT_PASTED_TEXT_TOKEN,
  nativeChatPastedTextId
} from './native-chat-pasted-text-reference'
import {
  nativeChatPastedTextAdmission,
  resolveNativeChatPastedText
} from './native-chat-composer-pasted-text-references'
import { nativeChatQueuedEditValueKey, sameQueuedEditImage } from './native-chat-queued-edit-value'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'
import { records, type DraftRecord } from './native-chat-composer-draft-memory'

export type NativeChatQueuedEditDraft = {
  scopeKey: string
  destination: string
  body: AgentJournalMessageItem
  baseKey: string
  initial: NativeChatComposerDraft
  returning: { destination: string; revoked?: DraftRecord }
  kept: (ReturnType<typeof queuedEditKeptImages>[number] & {
    image: NativeChatComposerDraftImage
  })[]
}

export function createNativeChatQueuedEditDraft(
  body: AgentJournalMessageItem,
  destination: string
): NativeChatQueuedEditDraft {
  const scopeKey = `queued-edit:${createUuidV4()}`
  const kept = queuedEditKeptImages(body)
  const text = promptMarkersToImageReferences(
    queuedMessageEditableText(body) ?? '',
    kept.map(({ id }) => id)
  )
  const initial: NativeChatComposerDraft = {
    text,
    document: seedPromptSkillReferences(promptTextContent(text), body.skills),
    images: kept.map(({ id, block }) => ({ id, path: block.path ?? block.url ?? '' }))
  }
  const edit: NativeChatQueuedEditDraft = {
    scopeKey,
    destination,
    body,
    baseKey: '',
    initial,
    returning: { destination },
    kept: kept.map((entry, index) => ({ ...entry, image: initial.images[index] }))
  }
  openNativeChatEditDraft(scopeKey, initial, edit.returning)
  edit.baseKey = nativeChatQueuedEditValueKey(scopeKey)
  return edit
}

export function nativeChatQueuedEditInput(
  edit: NativeChatQueuedEditDraft,
  imagesCapable: boolean,
  skillsCapable: boolean
): QueuedMessageEdit {
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  const text = imageReferencesToPromptMarkers(
    resolveNativeChatPastedText(edit.scopeKey, draft.text),
    draft.images.map(({ id }) => id)
  )
  const images = draft.images.map(
    (image) =>
      edit.kept.find((entry) => sameQueuedEditImage(entry.image, image))?.block ?? {
        type: 'image-ref' as const,
        path: image.path
      }
  )
  return {
    text,
    ...(imagesCapable ? { images } : {}),
    ...(skillsCapable
      ? { skills: pickedSkillsInText(text, promptSkillRefs(draft.document), ['$', '/']) }
      : {})
  }
}

export function nativeChatQueuedEditDirty(edit: NativeChatQueuedEditDraft): boolean {
  return nativeChatQueuedEditValueKey(edit.scopeKey) !== edit.baseKey
}

export function nativeChatQueuedEditHeld(
  edit: NativeChatQueuedEditDraft,
  imagesCapable: boolean
): boolean {
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  return (
    nativeChatPendingAttachmentSnapshot(edit.scopeKey).some(({ pending }) => pending) ||
    nativeChatPastedTextAdmission(edit.scopeKey) !== null ||
    (!imagesCapable && JSON.stringify(draft.images) !== JSON.stringify(edit.initial.images)) ||
    draft.images.some(({ unavailableName }) => unavailableName !== undefined)
  )
}

/** Move only draft-owned additions; card-owned images remain with the accepted message. */
export function handBackNativeChatQueuedEdit(
  edit: NativeChatQueuedEditDraft,
  force = false
): boolean {
  if (edit.returning.revoked && records.get(edit.scopeKey) === edit.returning.revoked) {
    return false
  }
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  let text = draft.text
  let document = draft.document
  const kept = edit.kept.filter((entry) =>
    draft.images.some((image) => sameQueuedEditImage(entry.image, image))
  )
  for (const { id } of kept) {
    text = withoutImageReference(text, id)
    if (document) {
      document = withoutImageReferenceNodes(document, id)
    }
  }
  const dirty = force || nativeChatQueuedEditDirty(edit)
  if (!dirty) {
    text = ''
    document = undefined
  }
  const images = draft.images.filter(
    (image) => !kept.some((entry) => sameQueuedEditImage(entry.image, image))
  )
  const pending = nativeChatPendingAttachmentSnapshot(edit.scopeKey)
  appendToNativeChatComposerDraft(
    edit.destination,
    {
      text,
      document,
      images,
      pastedTextFiles: draft.pastedTextFiles
    },
    undefined,
    undefined,
    false,
    edit.returning,
    records.get(edit.scopeKey),
    edit.scopeKey
  )
  redirectNativeChatEditDraft(edit.scopeKey, edit.destination)
  moveNativeChatPendingAttachments(edit.scopeKey, edit.destination)
  moveNativeChatStagedFiles(edit.scopeKey, edit.destination)
  reconcileNativeChatStagedDraft(edit.destination, records.get(edit.destination))
  const pastes: object[] = []
  for (const token of draft.text.split(NATIVE_CHAT_PASTED_TEXT_TOKEN)) {
    const id = nativeChatPastedTextId(token)
    const operation = id ? nativeChatPastedTextOperations.get(id) : undefined
    if (operation?.scopeKey === edit.scopeKey) {
      operation.scopeKey = edit.destination
      pastes.push(operation)
    }
  }
  transferNativeChatDraftReturn({
    permission: edit.returning,
    from: edit.scopeKey,
    to: edit.destination,
    chips: pending,
    pastes
  })
  return text !== '' || images.length > 0 || pending.length > 0
}

export function discardNativeChatQueuedEdit(edit: NativeChatQueuedEditDraft): void {
  clearNativeChatPendingAttachments(edit.scopeKey)
  closeNativeChatEditDraft(edit.scopeKey)
}
