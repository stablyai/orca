import { currentDraftScope } from '../../drafts/native-chat-launch-draft-source'

// Capture ownership before tab removal can erase it.
export const chipScopes = new Map<string, string>()
// Chips whose pasted image main is still saving; a composer going unavailable must not discard them.
export const savingImageChips = new Set<string>()
// Saved file references waiting behind an earlier chip that is still pending, so they land in paste order.
export const readyReferences = new Map<string, string>()

export function nativeChatPendingAttachmentScope(scope: string, id: string): string {
  return currentDraftScope(chipScopes.get(id) ?? scope)
}

export function hasNativeChatPendingAttachment(id: string): boolean {
  return chipScopes.has(id)
}

export function holdNativeChatPendingImageSave(id: string): void {
  savingImageChips.add(id)
}

export function releaseNativeChatPendingImageSave(id: string): void {
  savingImageChips.delete(id)
}
