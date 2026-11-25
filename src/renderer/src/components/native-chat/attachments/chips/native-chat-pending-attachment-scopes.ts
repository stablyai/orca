import { currentDraftScope } from '../../drafts/native-chat-launch-draft-source'

// Capture ownership before tab removal can erase it.
export const chipScopes = new Map<string, string>()
// Chips whose pasted image main is still saving; a composer going unavailable must not discard them.
export const savingImageChips = new Set<string>()

export function nativeChatPendingAttachmentScope(scope: string, id: string): string {
  return currentDraftScope(chipScopes.get(id) ?? scope)
}

export function hasNativeChatPendingAttachment(id: string): boolean {
  return chipScopes.has(id)
}

/** Only a chip still in a draft's cache can be held, so a removed chip never restarts save work. */
export function holdNativeChatPendingImageSave(id: string): boolean {
  if (!chipScopes.has(id)) {
    return false
  }
  savingImageChips.add(id)
  return true
}

export function releaseNativeChatPendingImageSave(id: string): void {
  savingImageChips.delete(id)
}
