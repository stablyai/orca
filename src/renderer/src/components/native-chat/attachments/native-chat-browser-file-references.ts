import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import type { AgentSessionWriteNoticePart } from '../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { isBrowserAttachmentToken } from '@/lib/files/drop/browser-attachment-files'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'

/**
 * The renderer-only browser files a message names, as attached images or as text references. Such a
 * reference is a key to bytes held only in this renderer: a host can never read it, so content that
 * still names one never leaves the renderer (see `nativeChatUnsendableMessageBody`). A staged
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

/**
 * The one outbound policy, for every content-bearing write to a host (a send, a create's first
 * message, a queued-card update, a goal): a body with no blocks, or one still naming a browser file,
 * may not leave. It is never edited to make it pass.
 */
export function nativeChatUnsendableMessageBody(
  body: Pick<AgentJournalMessageItem, 'blocks'>
): { kind: 'empty' } | { kind: 'browser-files'; references: string[] } | null {
  if (body.blocks.length === 0) {
    return { kind: 'empty' }
  }
  const references = nativeChatBrowserFileReferences(
    body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    body.blocks.flatMap((block) =>
      block.type === 'image-ref' && block.path ? [{ path: block.path }] : []
    )
  )
  return references.length ? { kind: 'browser-files', references } : null
}

/** A long list stops short: every one of them has to go, and the next refusal names the rest. */
const NAMES_SHOWN = 3

/**
 * What a refused write says about files this chat can't send: their names, that it was not sent, and
 * to attach them again. Not "expired": the file may be intact, in another chat's draft.
 */
export function nativeChatBrowserFileRefusalParts(
  references: readonly string[]
): AgentSessionWriteNoticePart[] {
  const names = references.map((reference) => basename(reference))
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return [
    {
      text: translate(
        'components.native-chat.composer.browserFilesNotHere',
        "Can't send {{names}} from this chat.",
        { names: names.length > NAMES_SHOWN ? `${shown}…` : shown }
      )
    },
    'notDoneSend',
    references.length > 1 ? 'reattachFiles' : 'reattachFile'
  ]
}
