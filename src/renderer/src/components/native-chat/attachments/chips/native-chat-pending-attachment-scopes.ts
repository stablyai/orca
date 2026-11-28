import { currentDraftScope } from '../../drafts/native-chat-launch-draft-source'

// Capture ownership before tab removal can erase it.
export const chipScopes = new Map<string, string>()

// A remounted composer can remove a chip while its original paste is still saving.
export const pendingClipboardImages = new Map<string, 'pending' | 'removed'>()

export function nativeChatPendingAttachmentScope(scope: string, id: string): string {
  return currentDraftScope(chipScopes.get(id) ?? scope)
}

export function hasNativeChatPendingAttachment(id: string): boolean {
  return chipScopes.has(id)
}
