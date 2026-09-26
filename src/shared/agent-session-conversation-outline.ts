// The conversation outline: every user message a structured session's transcript
// draws, loaded by the client or not, so the message rail can map the whole
// thread instead of only the pages a client happens to hold.
//
// Derived here from journal items with the same projection the transcript runs,
// so an outline entry's id, order, preview and image count are what the client's
// own row would show for that message — not a second reading that could disagree.

import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type { NativeChatBlock } from './native-chat-types'
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from './native-chat-row-content'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from './native-chat-transcript-projection'

/** Previews are cut on the host: the rail clamps to two lines, so a whole prompt
 *  would cross the wire only to be hidden. */
export const AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS = 200

export type AgentSessionConversationOutlineEntry = {
  /** The journal item id, which is also the transcript row's message id. */
  itemId: string
  /** Creation sequence, so a client can tell which entries its loaded window already covers. */
  sequence: number
  /** Prose with whitespace collapsed, at most the preview cap. Empty when the
   *  message is images only, or when the host dropped previews to fit the reply. */
  preview: string
  imageCount: number
}

export type AgentSessionConversationOutline = {
  sessionId: string
  /** Journal position the outline is current through: every user message created
   *  at or before `cursor.sequence` is listed, unless `omittedEntries` says otherwise. */
  cursor: AgentJournalCursor
  entries: AgentSessionConversationOutlineEntry[]
  /** Oldest entries left out because the whole list could not fit one reply. */
  omittedEntries: number
}

export type NativeChatUserMessagePreview = { text: string; imageCount: number }

const previews = new WeakMap<readonly NativeChatBlock[], NativeChatUserMessagePreview>()

/** What the rail shows for one user message; shared so a loaded row and an
 *  outline entry for the same message cannot preview differently. */
export function nativeChatUserMessagePreview(
  blocks: readonly NativeChatBlock[]
): NativeChatUserMessagePreview {
  const cached = previews.get(blocks)
  if (cached) {
    return cached
  }
  const content = deriveNativeChatRowContent(blocks)
  const preview = {
    text: content.markdown.replace(/\s+/g, ' ').trim(),
    imageCount: content.prose.filter((block) => block.type === 'image-ref').length
  }
  previews.set(blocks, preview)
  return preview
}

/** Cuts on a code-point boundary so a clipped emoji never leaves a lone surrogate. */
export function truncateOutlinePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  const last = text.charCodeAt(maxChars - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars
  return text.slice(0, end).trimEnd()
}

/** User messages that draw a transcript row, in transcript order. Projected over the
 *  whole journal, not user items alone: whether a user row survives depends on its
 *  neighbours (a harness sidecar folds into the turn before it) and its order on
 *  when it was observed. Previews are uncut; the reply bound owns length. */
export function projectAgentSessionConversationOutline(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): AgentSessionConversationOutlineEntry[] {
  const sequences = new Map<string, number>()
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      sequences.set(item.itemId, item.sequence)
    }
  }
  const entries: AgentSessionConversationOutlineEntry[] = []
  const transcript = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions)
  )
  for (const message of transcript) {
    const sequence = sequences.get(message.id)
    if (
      sequence === undefined ||
      message.role !== 'user' ||
      !nativeChatRowRendersContent(message.blocks)
    ) {
      continue
    }
    const preview = nativeChatUserMessagePreview(message.blocks)
    entries.push({
      itemId: message.id,
      sequence,
      preview: preview.text,
      imageCount: preview.imageCount
    })
  }
  return entries
}
