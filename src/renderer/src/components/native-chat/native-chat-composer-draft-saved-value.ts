import { basename } from '@/lib/path'
import { isNativeChatKeptPastePath } from './native-chat-image-paste'
import { isNativeChatPastedImagePath } from '../../../../shared/native-chat/native-chat-image-label'
import { isAgentSessionAttachmentStorePath } from '../../../../shared/agent-session/agent-session-attachments'
import type { DraftRecord } from './native-chat-composer-draft-memory'
import type {
  NativeChatComposerDraftImage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

/** An image the draft names but can no longer send, so the user can attach it again. */
export function unavailableNativeChatComposerDraftImage(
  image: NativeChatComposerDraftImage
): NativeChatComposerDraftImage {
  return image.unavailableName === undefined
    ? { id: image.id, path: '', unavailableName: basename(image.path) }
    : image
}

/** A local paste in Orca's paste folder: it outlives the run, so a restore can show and send it. */
export function isKeptLocalPaste(image: NativeChatComposerDraftImage): boolean {
  return !image.connectionId && isNativeChatKeptPastePath(image.path)
}

/** Omit launch seeds; retain durable local/server pastes, reduce other pastes to unavailable names, and drop empty records. */
export function savedNativeChatComposerDraftForm(
  record: DraftRecord
): StoredNativeChatComposerDraft | null {
  const { unsavedText, ...saved } = record
  const images = saved.images.map((image) =>
    isNativeChatPastedImagePath(image.path) &&
    !isKeptLocalPaste(image) &&
    !isAgentSessionAttachmentStorePath(image.path)
      ? unavailableNativeChatComposerDraftImage(image)
      : image
  )
  const text = saved.text === unsavedText ? '' : saved.text
  if (text === '' && images.length === 0) {
    return null
  }
  return { ...saved, text, images }
}
