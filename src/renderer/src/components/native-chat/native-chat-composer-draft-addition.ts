// Keep additions replayable so late hydration and crash recovery merge returned text/images without replacing the draft.

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

/** Assign matching placeholder ids once at attach time so replay preserves chip identity and fills each slot only once. */
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

/** Deduplicate returned text and image identities so replay after a crash applies the addition once. */
export function withNativeChatComposerDraftAddition(
  draft: NativeChatComposerDraft,
  addition: NativeChatComposerDraftAddition
): Pick<NativeChatComposerDraft, 'text' | 'images' | 'document'> {
  const fills = new Set(addition.fills)
  // An existing unique image id proves the addition already landed, regardless of later typing.
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
