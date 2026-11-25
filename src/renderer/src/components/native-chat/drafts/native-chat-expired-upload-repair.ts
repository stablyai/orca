import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { restoreNativeChatExpiredUploads } from './native-chat-staged-input'

/**
 * Expired uploads a hand-back could not restore because their staged originals were not this draft's
 * yet (a worktree's first send refused before its draft moved in). Kept per recipient draft:
 * returned image id → expired host path, and expired host paths in the returned text.
 */
const unrestored = new Map<string, { images: Map<string, string>; text: Set<string> }>()

export function noteNativeChatUnrestoredExpiredUploads(
  scope: string,
  images: readonly (readonly [id: string, host: string])[],
  text: readonly string[]
): void {
  if (images.length === 0 && text.length === 0) {
    return
  }
  const note = unrestored.get(scope) ?? { images: new Map(), text: new Set() }
  images.forEach(([id, host]) => note.images.set(id, host))
  text.forEach((host) => note.text.add(host))
  unrestored.set(scope, note)
}

/**
 * Staged originals just moved into this draft: restore the expired uploads noted for it, as the
 * hand-back would have, so its chips and file references point at the originals again and Send
 * uploads them afresh. Only originals that moved into this draft are used.
 */
export function repairNativeChatExpiredUploads(scope: string): void {
  const note = unrestored.get(scope)
  if (!note) {
    return
  }
  const restored = restoreNativeChatExpiredUploads(scope, [...note.images.values(), ...note.text])
  if (restored.size === 0) {
    return
  }
  const draft = readNativeChatComposerDraft(scope)
  const images = draft.images.map((image) => {
    const original = restored.get(note.images.get(image.id) ?? '')
    return original ? { id: image.id, path: original } : image
  })
  const text = nativeChatTextAttachmentParts(draft.text, true, (path) => restored.has(path))
    .map((part) =>
      part.path ? formatNativeChatFileReference(restored.get(part.path)!) : part.text
    )
    .join('')
  for (const [id, host] of note.images) {
    if (restored.has(host)) {
      note.images.delete(id)
    }
  }
  restored.forEach((_original, host) => note.text.delete(host))
  if (note.images.size === 0 && note.text.size === 0) {
    unrestored.delete(scope)
  }
  updateNativeChatComposerDraft(
    scope,
    text === draft.text ? { images } : { images, text, document: undefined },
    'immediate'
  )
}

/** The draft is gone for good: nothing will move into it to repair. */
export function forgetNativeChatUnrestoredExpiredUploads(scope: string): void {
  unrestored.delete(scope)
}
