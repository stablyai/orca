// Install a draft read back from storage, journal or another window, with its custody and source claims.

import { basename } from '@/lib/path'
import { readBrowserAttachmentFile } from '@/lib/browser-attachment-files'
import { stageNativeChatDraftFile } from './native-chat-draft-attachment-staging'
import {
  installNativeChatDraftRecord,
  reconcileRestoredImageChecks,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import {
  draftCustody,
  dropEmptyNativeChatDraftCustody,
  scopeCustody
} from './native-chat-composer-draft-custody'
import { projectStoredNativeChatDraftCustody } from './native-chat-composer-draft-receipt-proof'
import type {
  NativeChatComposerDraftImage,
  NativeChatDraftHandbackReceipt,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

// Matches the claim tokens of browser-attachment-files: their bytes live only in the run that held them.
const BROWSER_FILE_PREFIX = 'orca-browser-file:'

/** An image the draft names but can no longer send, so the user can attach it again. */
export function unavailableNativeChatComposerDraftImage(
  image: NativeChatComposerDraftImage
): NativeChatComposerDraftImage {
  return image.unavailableName === undefined
    ? { id: image.id, path: '', unavailableName: basename(image.path) }
    : image
}

/** Re-claims the client files its provenance names so Send prepares them; true when lost browser bytes changed the content. */
export function installStoredNativeChatComposerDraft(
  scopeKey: string,
  stored: StoredNativeChatComposerDraft,
  durable: readonly NativeChatDraftHandbackReceipt[],
  position?: NativeChatDraftPosition
): boolean {
  const { handbacks: _handbacks, sourcePaths: _sourcePaths, ...content } = stored
  projectStoredNativeChatDraftCustody(scopeKey, stored, durable)
  // The stored content replaces memory's, and its provenance with it.
  if (stored.sourcePaths?.length || draftCustody.has(scopeKey)) {
    scopeCustody(scopeKey, stored.savedAt).sourcePaths = [...(stored.sourcePaths ?? [])]
  }
  const custody = draftCustody.get(scopeKey)
  const gone = new Set<string>()
  for (const path of custody?.sourcePaths ?? []) {
    if (path.startsWith(BROWSER_FILE_PREFIX) && !readBrowserAttachmentFile(path)) {
      gone.add(path)
    } else {
      stageNativeChatDraftFile(scopeKey, path)
    }
  }
  if (custody && gone.size) {
    custody.sourcePaths = custody.sourcePaths.filter((path) => !gone.has(path))
    dropEmptyNativeChatDraftCustody(scopeKey)
  }
  const images = content.images.map((image) =>
    gone.has(image.path) ? unavailableNativeChatComposerDraftImage(image) : image
  )
  const changed = images.some((image, index) => image !== content.images[index])
  const draft =
    content.text === '' && images.length === 0
      ? undefined
      : { ...content, images: changed ? images : content.images }
  reconcileRestoredImageChecks(scopeKey, draft?.images ?? [], records.get(scopeKey)?.images ?? [])
  installNativeChatDraftRecord(scopeKey, draft, draft && position)
  return changed
}
