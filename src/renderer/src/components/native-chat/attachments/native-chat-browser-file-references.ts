import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import type { AgentSessionWriteNoticePart } from '../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import { isBrowserAttachmentToken } from '@/lib/files/drop/browser-attachment-files'
import { basename } from '@/lib/path'

/**
 * The renderer-only browser files a message names, as attached images or as text references. Such a
 * reference is a key to bytes held only in this renderer: a host can never read it, so content that
 * still names one never leaves the renderer (see `structuredAgentSessionUnsendableBody`). A staged
 * original becomes a host upload in preparation; anything left is refused whole, never edited, so the
 * message keeps its image numbering and its content.
 */
export function nativeChatBrowserFileReferences(
  text: string,
  attachments: readonly { path: string }[] = []
): string[] {
  return [
    ...new Set([
      ...attachments.flatMap(({ path }) => (isBrowserAttachmentToken(path) ? [path] : [])),
      ...nativeChatTextAttachmentParts(text, true, isBrowserAttachmentToken).flatMap((part) =>
        part.path ? [part.path] : []
      )
    ])
  ]
}

/** What a refused send says: the files it names, that it was not sent, and to attach them again. */
export function nativeChatBrowserFileRefusalParts(
  references: readonly string[]
): AgentSessionWriteNoticePart[] {
  return [
    { expiredAttachmentNames: references.map((reference) => basename(reference)) },
    'notDoneSend',
    references.length > 1 ? 'reattachFiles' : 'reattachFile'
  ]
}
