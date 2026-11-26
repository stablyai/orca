import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/workspace/creation/pending-worktree-creation'
import { ownedNativeChatStagedInput } from '@/components/native-chat/drafts/native-chat-expired-upload-restore'

/**
 * The first send a pending creation makes from its source draft, on its first try and on each Retry:
 * its text and held images, less any browser file this draft no longer stages (a refusal's hand-back
 * gave it to the chat it returned to, which now owns it). That file's renderer-only reference would
 * mean nothing to the host, so neither the attachment nor its text reference is sent from here again.
 */
export function worktreeCreationFirstSend(
  sourceScope: string,
  request: Pick<WorktreeCreationRequest, 'launchDraftPrompt' | 'quickPrompt'>,
  pending: Pick<PendingWorktreeCreation, 'heldChatAttachments'> | undefined
): { text: string; attachments?: { path: string; previewUri: string; connectionId?: string }[] } {
  return ownedNativeChatStagedInput(sourceScope, {
    text: request.launchDraftPrompt ?? request.quickPrompt,
    attachments: pending?.heldChatAttachments?.map(({ path, connectionId }) => ({
      path,
      previewUri: '',
      ...(connectionId ? { connectionId } : {})
    }))
  })
}
