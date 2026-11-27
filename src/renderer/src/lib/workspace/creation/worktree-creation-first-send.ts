import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/workspace/creation/pending-worktree-creation'
import { nativeChatBrowserFileReferences } from '@/components/native-chat/attachments/native-chat-browser-file-references'

type FirstSend = {
  text: string
  attachments?: { path: string; previewUri: string; connectionId?: string }[]
}

/**
 * The first send a pending creation makes from its source draft, on its first try and on each Retry,
 * exactly as captured: its text, already numbered `[Image #k]` by these attachments, and its held
 * images. It is never edited here: removing an image would leave the numbers on the wrong images.
 * Whatever of it names a browser file this chat can no longer upload is refused whole where a message
 * leaves the renderer.
 */
export function worktreeCreationFirstSend(
  request: Pick<WorktreeCreationRequest, 'launchDraftPrompt' | 'quickPrompt'>,
  pending:
    | Pick<PendingWorktreeCreation, 'heldChatAttachments' | 'heldChatMessageRecorded'>
    | undefined
): FirstSend {
  if (pending?.heldChatMessageRecorded) {
    return { text: '' }
  }
  return {
    text: request.launchDraftPrompt ?? request.quickPrompt,
    attachments: pending?.heldChatAttachments?.map(({ path, connectionId }) => ({
      path,
      previewUri: '',
      ...(connectionId ? { connectionId } : {})
    }))
  }
}

/**
 * Whether the first send must stay in chat. Images, skills, input still held by the source, or any
 * browser-file reference (only a chat can refuse it with its notice; a terminal agent would be handed
 * the renderer-only reference as text).
 */
export function worktreeCreationFirstSendNeedsChat(
  firstSend: FirstSend,
  skills: readonly unknown[] | undefined,
  sourceHoldsInput: () => boolean
): boolean {
  return (
    Boolean(firstSend.attachments?.length || skills?.length) ||
    nativeChatBrowserFileReferences(firstSend.text).length > 0 ||
    sourceHoldsInput()
  )
}
