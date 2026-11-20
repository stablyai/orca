// The comment box's words replaced from outside it (a quick reply to add to, a held answer to change):
// with images, each [Image #N] comes back as its image's chip and thumbnail. What the box held is set
// aside meanwhile, and comes back once the box sends.
import { promptMarkersToImageReferences } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'
import { moveNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-move'

const asideScope = (scopeKey: string): string => `${scopeKey}:aside`

function isEmpty(scopeKey: string): boolean {
  const draft = readNativeChatComposerDraft(scopeKey)
  return !draft.text.trim() && draft.images.length === 0
}

/** The box's new text: `text` with room to type after it. */
export function fillBotItemCommentDraft(
  scopeKey: string,
  text: string,
  paths: readonly string[]
): string {
  // Only the owner's own draft is set aside: one filled in earlier is a copy of what it changes.
  if (!isEmpty(scopeKey) && isEmpty(asideScope(scopeKey))) {
    moveNativeChatComposerDraft(scopeKey, asideScope(scopeKey))
  }
  const images = paths.map((path) => ({ id: createNonSecureContextUuid(), path }))
  const filled = `${promptMarkersToImageReferences(
    text,
    images.map(({ id }) => id)
  )} `
  // The whole draft: no image of what was in the box stays to be named by these words.
  updateNativeChatComposerDraft(
    scopeKey,
    { text: filled, document: undefined, images },
    'immediate'
  )
  return filled
}

/** After a send: the draft set aside comes back to the emptied box. */
export function restoreBotItemCommentDraft(scopeKey: string): void {
  if (isEmpty(scopeKey) && !isEmpty(asideScope(scopeKey))) {
    moveNativeChatComposerDraft(asideScope(scopeKey), scopeKey)
  }
}
