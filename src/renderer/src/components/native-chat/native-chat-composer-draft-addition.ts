// What is added to a draft without replacing it: text given back (Stop, a queued card's Edit) and
// images given back or attached. Kept as data, so the same addition can be made again on a draft
// loaded later, or replayed from the journal after a crash.

import { appendReturnedDraftText } from '../../../../shared/returned-draft-text'
import { appendPromptDocumentText } from './native-chat-prompt-document-text'
import { basename } from '@/lib/path'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'

export type NativeChatComposerDraftAddition = {
  readonly text?: string
  readonly images?: readonly NativeChatComposerDraftImage[]
  /** Only an image the user attaches takes the place of a placeholder with its file name. */
  readonly fromUser?: boolean
  /** The held image the new ones go in front of, so they keep the order they were attached in. */
  readonly before?: string
  /** Placeholders the images with their ids fill; see `placeNativeChatComposerDraftAddition`. */
  readonly fills?: readonly string[]
}

/** Gives each image the user attached that takes the place of a placeholder with its file name
 *  that placeholder's id, which its chips name. Decided once, on the draft the user attached it
 *  to, so a replay fills that place or finds it filled, and tells every other image by its id. */
export function placeNativeChatComposerDraftAddition(
  draft: NativeChatComposerDraft,
  addition: NativeChatComposerDraftAddition
): NativeChatComposerDraftAddition {
  if (!addition.fromUser || !addition.images) {
    return addition
  }
  const fills: string[] = []
  const images = addition.images.map((image) => {
    const placeholder = draft.images.find(
      (held) => held.unavailableName === basename(image.path) && !fills.includes(held.id)
    )
    if (!placeholder) {
      return image
    }
    fills.push(placeholder.id)
    return { ...image, id: placeholder.id }
  })
  return fills.length === 0 ? addition : { ...addition, images, fills }
}

/**
 * The draft's text and images with the addition made. Text follows the shared returned-text rule,
 * which never adds a paragraph the draft already ends with; an image the draft holds is not added
 * again, so a replay after a crash makes the addition once.
 */
export function withNativeChatComposerDraftAddition(
  draft: NativeChatComposerDraft,
  addition: NativeChatComposerDraftAddition
): Pick<NativeChatComposerDraft, 'text' | 'images' | 'document'> {
  const fills = new Set(addition.fills)
  // Image ids are unique to a message or attach, so one the draft holds means it was added already,
  // whatever was typed since.
  if (
    addition.images?.some(({ id }) => !fills.has(id) && draft.images.some((held) => held.id === id))
  ) {
    return { text: draft.text, images: draft.images, document: draft.document }
  }
  const text = appendReturnedDraftText(draft.text, addition.text ?? '')
  const images = [...draft.images]
  let at = addition.before ? images.findIndex((held) => held.id === addition.before) : -1
  for (const { id, path, connectionId } of addition.images ?? []) {
    const image = { id, path, ...(connectionId ? { connectionId } : {}) }
    const held = images.findIndex((candidate) => candidate.id === id)
    if (fills.has(id) && held !== -1) {
      // One already filled stays as it is.
      if (images[held].unavailableName !== undefined) {
        images[held] = image
      }
    } else if (at === -1) {
      images.push(image)
    } else {
      images.splice(at++, 0, image)
    }
  }
  return { text, images, document: appendPromptDocumentText(draft.document, draft.text, text) }
}
