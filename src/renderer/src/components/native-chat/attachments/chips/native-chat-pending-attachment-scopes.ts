import { currentDraftScope } from '../../drafts/native-chat-launch-draft-source'

// Capture ownership before tab removal can erase it.
export const chipScopes = new Map<string, string>()

export function nativeChatPendingAttachmentScope(scope: string, id: string): string {
  return currentDraftScope(chipScopes.get(id) ?? scope)
}

export function hasNativeChatPendingAttachment(id: string): boolean {
  return chipScopes.has(id)
}
