import { clearNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'

/** Takes every image out of the draft except `keep`, in one write, so a restart never finds the
 *  draft between taking the images out and putting the kept ones back. */
export function clearNativeChatComposerImagesExcept(
  scopeKey: string,
  keep: readonly string[] = []
): void {
  clearNativeChatPendingAttachments(scopeKey)
  const images = readNativeChatComposerDraft(scopeKey).images.filter(({ id }) => keep.includes(id))
  updateNativeChatComposerDraft(scopeKey, { images }, 'immediate')
}
