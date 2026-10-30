// Keep additions replayable so late hydration and crash recovery merge returned text/images without replacing the draft.

import type { JSONContent } from '@tiptap/react'
import { promptTextContent, appendPromptDocumentText } from './native-chat-prompt-document-text'
import { appendReturnedDraftText } from '../../../../shared/returned-draft-text'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../shared/structured-agent-session-composer'
import { basename } from '@/lib/path'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'

export type NativeChatComposerDraftAddition = {
  readonly text?: string
  readonly document?: JSONContent
  readonly pastedTextFiles?: Readonly<Record<string, string>>
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
): Pick<NativeChatComposerDraft, 'text' | 'images' | 'document' | 'pastedTextFiles'> {
  const fills = new Set(addition.fills)
  // An existing unique image id proves the addition already landed, regardless of later typing.
  if (
    addition.images?.some(({ id }) => !fills.has(id) && draft.images.some((held) => held.id === id))
  ) {
    return {
      text: draft.text,
      images: draft.images,
      document: draft.document,
      pastedTextFiles: draft.pastedTextFiles
    }
  }
  const returned = addition.text ?? ''
  const kept = draft.text.trimEnd()
  const replaces = kept === '' || isLoneStructuredAgentSessionConversationCommand(kept)
  let text = appendReturnedDraftText(draft.text, returned)
  const returnedBlocks = addition.document?.content ?? []
  const heldBlocks = draft.document?.content ?? promptTextContent(draft.text).content ?? []
  // Equal visible tokens do not establish equal selected files.
  if (
    addition.document &&
    returned.trim() &&
    text === draft.text &&
    JSON.stringify(heldBlocks.slice(-returnedBlocks.length)) !== JSON.stringify(returnedBlocks)
  ) {
    text = `${kept}\n\n${returned}`
  }
  const images = [...draft.images]
  let at = addition.before ? images.findIndex((held) => held.id === addition.before) : -1
  for (const image of addition.images ?? []) {
    const { id } = image
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
  const document =
    text === draft.text
      ? draft.document
      : addition.document
        ? replaces
          ? addition.document
          : {
              type: 'doc',
              content: [
                ...(appendPromptDocumentText(
                  draft.document ?? promptTextContent(draft.text),
                  draft.text,
                  kept
                )?.content ?? []),
                { type: 'paragraph' },
                ...returnedBlocks
              ]
            }
        : replaces
          ? promptTextContent(text)
          : appendPromptDocumentText(draft.document, draft.text, text)
  return {
    text,
    images,
    document,
    pastedTextFiles: { ...draft.pastedTextFiles, ...addition.pastedTextFiles }
  }
}
