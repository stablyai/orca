import {
  nativeChatReplyTargetFromSentText,
  readNativeChatReplyTarget,
  releaseNativeChatReplyScope,
  restoreNativeChatReplyTarget,
  setNativeChatReplyTarget
} from '../../composer/reply/native-chat-reply-target'
import { withNativeChatReplyContext } from '../../composer/reply/native-chat-reply-quote'
import { rememberNativeChatReplySource } from '../../composer/reply/native-chat-reply-sources'
import { nativeChatQuotedPromptDocument } from './native-chat-queued-edit-quote'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withoutImageReference } from '../../../../../../shared/native-chat/attachments/native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from '../../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import {
  queuedEditKeptImages,
  queuedMessageEditableText,
  type QueuedMessageEdit
} from '../../../../../../shared/native-chat/input/queued-messages/queued-message-edit'
import { pickedSkillsInText } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { createNonSecureContextUuid as createUuidV4 } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { promptSkillRefs } from '../../composer/editor/native-chat-prompt-document'
import {
  promptTextContent,
  seedPromptSkillReferences,
  withoutImageReferenceNodes
} from '../../composer/editor/native-chat-prompt-document-text'
import {
  appendToNativeChatComposerDraft,
  openNativeChatEditDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import {
  redirectNativeChatEditDraft,
  closeNativeChatEditDraft
} from '../../drafts/native-chat-composer-draft-memory'
import {
  clearNativeChatPendingAttachments,
  moveNativeChatPendingAttachments,
  nativeChatPendingAttachmentSnapshot
} from '../../attachments/chips/native-chat-pending-attachment-cache'
import {
  nativeChatPastedTextOperations,
  NATIVE_CHAT_PASTED_TEXT_TOKEN,
  nativeChatPastedTextId
} from '../../paste/native-chat-pasted-text-reference'
import {
  nativeChatPastedTextAdmission,
  resolveNativeChatPastedText
} from '../../paste/native-chat-composer-pasted-text-references'
import { nativeChatQueuedEditValueKey, sameQueuedEditImage } from './native-chat-queued-edit-value'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from '../../drafts/native-chat-composer-draft-storage'

export type NativeChatQueuedEditDraft = {
  scopeKey: string
  destination: string
  body: AgentJournalMessageItem
  baseKey: string
  initial: NativeChatComposerDraft
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
  // The card's reply quote is edited as a reply strip on this scope and put back on save.
  const { rest, target: reply } = nativeChatReplyTargetFromSentText(
    queuedMessageEditableText(body) ?? '',
    destination
  )
  if (reply) {
    setNativeChatReplyTarget(scopeKey, reply, { ephemeral: true })
  }
  const text = promptMarkersToImageReferences(
    rest,
    kept.map(({ id }) => id)
  )
  const initial: NativeChatComposerDraft = {
    text,
    document: seedPromptSkillReferences(promptTextContent(text), body.skills),
    images: kept.map(({ id, block }) => ({ id, path: block.path ?? block.url ?? '' }))
  }
  openNativeChatEditDraft(scopeKey, initial)
  return {
    scopeKey,
    destination,
    body,
    baseKey: nativeChatQueuedEditValueKey(scopeKey),
    initial,
    kept: kept.map((entry, index) => ({ ...entry, image: initial.images[index] }))
  }
}

export function nativeChatQueuedEditInput(
  edit: NativeChatQueuedEditDraft,
  imagesCapable: boolean,
  skillsCapable: boolean
): QueuedMessageEdit {
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  const words = imageReferencesToPromptMarkers(
    resolveNativeChatPastedText(edit.scopeKey, draft.text),
    draft.images.map(({ id }) => id)
  )
  const reply = readNativeChatReplyTarget(edit.scopeKey)
  const text = withNativeChatReplyContext(words, reply, 'the agent')
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

/** A saved edit replaced the queued message with `text`: it answers the same original. */
export function rememberNativeChatQueuedEditReplySource(
  edit: NativeChatQueuedEditDraft,
  text: string
): void {
  const reply = readNativeChatReplyTarget(edit.scopeKey)
  if (reply) {
    rememberNativeChatReplySource(edit.destination, text, reply.messageId)
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
  // The edited words still answer the same message: the main box takes the reply, or the quote if
  // it already answers another.
  const reply = dirty ? readNativeChatReplyTarget(edit.scopeKey) : null
  if (reply && !restoreNativeChatReplyTarget(edit.destination, reply)) {
    // The editor shows the rich document, so the quote goes into both or typing would drop it.
    const quoted = withNativeChatReplyContext(text, reply, 'the agent')
    document = nativeChatQuotedPromptDocument(document, text, quoted)
    text = quoted
  }
  releaseNativeChatReplyScope(edit.scopeKey)
  const pending = nativeChatPendingAttachmentSnapshot(edit.scopeKey)
  appendToNativeChatComposerDraft(edit.destination, {
    text,
    document,
    images,
    pastedTextFiles: draft.pastedTextFiles
  })
  redirectNativeChatEditDraft(edit.scopeKey, edit.destination)
  moveNativeChatPendingAttachments(edit.scopeKey, edit.destination)
  for (const token of draft.text.split(NATIVE_CHAT_PASTED_TEXT_TOKEN)) {
    const id = nativeChatPastedTextId(token)
    const operation = id ? nativeChatPastedTextOperations.get(id) : undefined
    if (operation?.scopeKey === edit.scopeKey) {
      operation.scopeKey = edit.destination
    }
  }
  return text !== '' || images.length > 0 || pending.length > 0
}

export function discardNativeChatQueuedEdit(edit: NativeChatQueuedEditDraft): void {
  releaseNativeChatReplyScope(edit.scopeKey)
  clearNativeChatPendingAttachments(edit.scopeKey)
  closeNativeChatEditDraft(edit.scopeKey)
}
