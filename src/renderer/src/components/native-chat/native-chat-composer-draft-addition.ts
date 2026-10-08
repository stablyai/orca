// What is added to a draft without replacing it: text given back (Stop, a queued card's Edit) and
// images given back or attached. Kept as data, so the same addition can be made again on a draft
// loaded later, or replayed from the journal after a crash.

import { appendReturnedDraftText } from '../../../../shared/returned-draft-text'
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
}

/**
 * The draft's text and images with the addition made. Text follows the shared returned-text rule,
 * which never adds a paragraph the draft already ends with. `once` does the same for images (an id
 * the draft holds): a replay after a crash meets a draft that may already have been saved with it.
 */
export function withNativeChatComposerDraftAddition(
  draft: NativeChatComposerDraft,
  addition: NativeChatComposerDraftAddition,
  options: { once?: boolean } = {}
): Pick<NativeChatComposerDraft, 'text' | 'images'> {
  const text = appendReturnedDraftText(draft.text, addition.text ?? '')
  const images = [...draft.images]
  for (const { id, path, connectionId } of addition.images ?? []) {
    if (options.once && images.some((held) => held.id === id)) {
      continue
    }
    const image = { id, path, ...(connectionId ? { connectionId } : {}) }
    const placeholder = addition.fromUser
      ? images.findIndex((held) => held.unavailableName === basename(path))
      : -1
    if (placeholder === -1) {
      images.push(image)
    } else {
      images[placeholder] = image
    }
  }
  return { text, images }
}
