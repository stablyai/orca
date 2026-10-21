import type { AgentJournalMessageItem } from './agent-session-journal-types'
import { MAX_BLOCKS, MAX_PROMPT_BYTES } from './rpc-contract/structured-agent-session-params'
import { imageReferenceInsertion, imageReferenceToken } from './native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from './native-chat-image-transcript-markers'

export type QueuedMessageImageBlock = Extract<
  AgentJournalMessageItem['blocks'][number],
  { type: 'image-ref' }
>

/** What Save writes: the text, and when `images` is given, the complete ordered image set. */
export type QueuedMessageEdit = { text: string; images?: readonly QueuedMessageImageBlock[] }

export type QueuedMessageEditResult =
  | { ok: true; body: AgentJournalMessageItem }
  | { ok: false; reason: 'not-editable' | 'empty' | 'too-large' | 'too-many-blocks' }

/** The text an in-place edit starts from, or null when the card is not editable: a command is
 *  not a draft, and a block this edit cannot carry over unchanged refuses rather than drops. */
export function queuedMessageEditableText(body: AgentJournalMessageItem): string | null {
  if (body.command || body.blocks.some((b) => b.type !== 'text' && b.type !== 'image-ref')) {
    return null
  }
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function imageBlocks(body: AgentJournalMessageItem): QueuedMessageImageBlock[] {
  return body.blocks.filter((block): block is QueuedMessageImageBlock => block.type === 'image-ref')
}

function sameImages(
  a: readonly QueuedMessageImageBlock[],
  b: readonly QueuedMessageImageBlock[]
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.path === b[i]?.path && x.url === b[i]?.url && x.alt === b[i]?.alt)
  )
}

/** An edit in progress: the typed text, the card's own image blocks still kept (verbatim), and
 *  the images added in this edit, whose `path` is empty while the upload is pending. */
export type QueuedMessageEditDraft = {
  text: string
  kept: readonly { id: string; block: QueuedMessageImageBlock }[]
  added: readonly { id: string; path: string; pending?: boolean }[]
}

/** The card's image blocks an edit starts from, each with a chip id that survives removals. */
export function queuedEditKeptImages(
  body: AgentJournalMessageItem
): { id: string; block: QueuedMessageImageBlock }[] {
  return body.blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [{ id: `kept-${index}`, block }] : []
  )
}

/** Markers follow the complete image order; references to removed images go with their chips. */
export function queuedEditTextForKeptImages(
  text: string,
  from: readonly string[],
  to: readonly string[]
): string {
  let chips = promptMarkersToImageReferences(text, from)
  const staying = new Set(to)
  for (const id of from.filter((entry) => !staying.has(entry))) {
    const token = imageReferenceToken(id)
    chips = chips.replaceAll(`${token} `, '').replaceAll(token, '')
  }
  return imageReferencesToPromptMarkers(chips, to)
}

/** Added references are derived at Save, so attachment changes never rewrite the field. */
export function queuedEditTextWithAddedImages(draft: QueuedMessageEditDraft): string {
  const addedIds = draft.added.filter((image) => !image.pending).map(({ id }) => id)
  const suffix = imageReferenceInsertion(draft.text, '', addedIds)
  return (
    draft.text +
    imageReferencesToPromptMarkers(suffix, [...draft.kept.map(({ id }) => id), ...addedIds])
  )
}

/** The text an edit's typing is measured against: the card's own, its markers following the
 *  images removed so far, so a removal alone is not typing. */
export function queuedEditBaseText(
  body: AgentJournalMessageItem,
  kept: readonly { id: string }[]
): string | null {
  const text = queuedMessageEditableText(body)
  return text === null
    ? null
    : queuedEditTextForKeptImages(
        text,
        queuedEditKeptImages(body).map(({ id }) => id),
        kept.map(({ id }) => id)
      )
}

function queuedEditImagesChanged(
  body: AgentJournalMessageItem,
  draft: QueuedMessageEditDraft
): boolean {
  const kept = draft.kept.map(({ block }) => block)
  return draft.added.length > 0 || !sameImages(kept, imageBlocks(body))
}

/** Save waits: an added image is still uploading, or the image set changed while the host no
 *  longer reads as taking images (a failed re-check), where text alone would keep the old images
 *  under renumbered markers. Derived, so it clears once the host answers again. */
export function queuedEditSaveHeld(
  body: AgentJournalMessageItem,
  draft: QueuedMessageEditDraft,
  imagesCapable: boolean
): boolean {
  return queuedEditImagesPending(draft) || (!imagesCapable && queuedEditImagesChanged(body, draft))
}

export function queuedEditDirty(
  body: AgentJournalMessageItem,
  draft: QueuedMessageEditDraft
): boolean {
  return draft.text !== queuedMessageEditableText(body) || queuedEditImagesChanged(body, draft)
}

export function queuedEditImagesPending(draft: QueuedMessageEditDraft): boolean {
  return draft.added.some((image) => image.pending)
}

/** What Save writes; the image set only when it changed and the host takes it, so a text-only
 *  Save stays what every host accepts. */
export function queuedEditInput(
  body: AgentJournalMessageItem,
  draft: QueuedMessageEditDraft,
  imagesCapable: boolean
): QueuedMessageEdit {
  if (!imagesCapable || !queuedEditImagesChanged(body, draft)) {
    return { text: draft.text }
  }
  const added = draft.added.flatMap((image) =>
    image.pending ? [] : [{ type: 'image-ref' as const, path: image.path }]
  )
  return {
    text: queuedEditTextWithAddedImages(draft),
    images: [...draft.kept.map(({ block }) => block), ...added]
  }
}

/** The edited body; sender, kind and send mode stay. Without `images` the text replaces the
 *  first text block in place and attachments stay; with them the blocks are rebuilt in a fresh
 *  send's order (text, then images), within the limits `SendBody` enforces. */
export function queuedMessageWithEdit(
  body: AgentJournalMessageItem,
  edit: QueuedMessageEdit
): QueuedMessageEditResult {
  const { text, images } = edit
  const editable = queuedMessageEditableText(body)
  if (editable === null) {
    return { ok: false, reason: 'not-editable' }
  }
  if (byteLength(text) > MAX_PROMPT_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  if (!text.trim() && (images ? images.length === 0 : imageBlocks(body).length === 0)) {
    return { ok: false, reason: 'empty' }
  }
  // Unchanged text and images keep their blocks, so a Save that changes nothing is a no-op.
  if (text === editable && (!images || sameImages(images, imageBlocks(body)))) {
    return { ok: true, body }
  }
  // Plain-text edits cannot retain which occurrence owned a picked file.
  const { skills: _pickedSkills, ...plainBody } = body
  if (images) {
    const blocks: AgentJournalMessageItem['blocks'] = [
      ...(text.trim() ? [{ type: 'text' as const, text: text.trimEnd() }] : []),
      ...images
    ]
    if (blocks.length > MAX_BLOCKS) {
      return { ok: false, reason: 'too-many-blocks' }
    }
    if (byteLength(JSON.stringify(blocks)) > MAX_PROMPT_BYTES) {
      return { ok: false, reason: 'too-large' }
    }
    return { ok: true, body: { ...plainBody, blocks } }
  }
  const blocks: AgentJournalMessageItem['blocks'] = []
  let placed = false
  for (const block of body.blocks) {
    if (block.type !== 'text') {
      blocks.push(block)
    } else if (!placed) {
      blocks.push({ type: 'text', text })
      placed = true
    }
  }
  if (!placed) {
    blocks.unshift({ type: 'text', text })
  }
  return { ok: true, body: { ...plainBody, blocks } }
}
