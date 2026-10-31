// Project every human-authored journal user row, including unloaded pages, with the transcript projection so rail identity, order and preview cannot disagree.

import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../native-chat-types'
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from '../native-chat-row-content'
import { iterateProcessOutputLines } from '../process-output-field-scanner'
import { agentJournalSubmissionKey } from '../agent-session-journal-item-key'
import { dispatchWasWithdrawn } from '../structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from '../structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../native-chat-transcript-projection'
import { nativeChatTurnMembership } from '../native-chat-turn-membership'

/** Cap previews on the host because the rail hides prose beyond two lines. */
export const AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS = 200

export type AgentSessionConversationOutlineEntry = {
  itemId: string
  /** Creation sequence, so a client can tell which entries its loaded window already covers. */
  sequence: number
  /** Collapsed prose capped for preview; empty for images-only messages or when omitted to fit the reply. */
  preview: string
  imageCount: number
  /** The opening message of this steer's running turn; absent on older hosts. */
  turnKey?: string
  /** Reply prose; absent for no reply, an older host or omission to fit the reply. */
  reply?: string
}

export type AgentSessionConversationOutline = {
  sessionId: string
  /** Absent on older hosts whose outlines can include agent-authored turn inputs. */
  humanMessagesOnly?: true
  /** Journal position the outline is current through: every human-authored message created
   *  at or before `cursor.sequence` is listed, unless `omittedEntries` says otherwise. */
  cursor: AgentJournalCursor
  entries: AgentSessionConversationOutlineEntry[]
  /** Oldest entries left out because the whole list could not fit one reply. */
  omittedEntries: number
}

export type NativeChatUserMessagePreview = { text: string; imageCount: number }

const previews = new WeakMap<readonly NativeChatBlock[], NativeChatUserMessagePreview>()

/** Share preview formatting between loaded transcript rows and outline entries. */
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

const replies = new WeakMap<readonly NativeChatBlock[], string>()

/** An assistant message as preview prose: fenced code, rules and markdown markers
 *  dropped, cut to the preview cap. */
function assistantReplyProse(blocks: readonly NativeChatBlock[]): string {
  const cached = replies.get(blocks)
  if (cached !== undefined) {
    return cached
  }
  const lines: string[] = []
  let length = 0
  let fenced = false
  // Lazily, stopping at the cap: a reply can be many thousands of lines.
  for (const raw of iterateProcessOutputLines(deriveNativeChatRowContent(blocks).markdown)) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      continue
    }
    const plain = line
      .replace(/^(?:[#>]+|[-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*|`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!/[\p{L}\p{N}]/u.test(plain)) {
      continue
    }
    lines.push(plain)
    length += plain.length + 1
    if (length > AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS) {
      break
    }
  }
  const prose = truncateOutlinePreview(lines.join(' '), AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS)
  replies.set(blocks, prose)
  return prose
}

/** Last assistant prose per transcript turn. Use nativeChatTurnMembership turnKeys so steers/queued prompts cannot truncate a reply; only limits the read to one turn. */
export function nativeChatTurnReplyPreviews(
  messages: readonly Pick<NativeChatMessage, 'role' | 'blocks'>[],
  turnKeys: readonly (string | undefined)[],
  only?: string
): Map<string, string> {
  const replies = new Map<string, string>()
  // Newest first, so a long agentic turn reads one message, not every aside before it.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnKey = turnKeys[index]
    if (
      turnKey === undefined ||
      (only !== undefined && turnKey !== only) ||
      messages[index].role !== 'assistant' ||
      replies.has(turnKey)
    ) {
      continue
    }
    const prose = assistantReplyProse(messages[index].blocks)
    if (prose.length > 0) {
      replies.set(turnKey, prose)
      if (only !== undefined) {
        break
      }
    }
  }
  return replies
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

/** Project the whole journal: neighbours decide whether a user row survives, and journal position sets its order. Leave previews uncut for the reply bound. */
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
  // Served to clients of every version, so a send a Stop took back stays out, as it always was.
  const stopped = new Set(
    submissions
      .filter((submission) => dispatchWasWithdrawn(submission))
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const entries: AgentSessionConversationOutlineEntry[] = []
  const transcript = projectNativeChatTranscriptMessages(
    // Unchanged on the wire: a not-sent row ticks only once a desktop loads its page.
    projectStructuredAgentSessionMessages(items, [], submissions).filter(
      (message) => !message.unsent
    )
  )
  const { turnKeys } = nativeChatTurnMembership(transcript, { items, submissions })
  const replies = nativeChatTurnReplyPreviews(transcript, turnKeys)
  for (const [index, message] of transcript.entries()) {
    const sequence = sequences.get(message.id)
    if (
      sequence === undefined ||
      stopped.has(message.id) ||
      message.role !== 'user' ||
      message.from !== undefined ||
      !nativeChatRowRendersContent(message.blocks)
    ) {
      continue
    }
    const preview = nativeChatUserMessagePreview(message.blocks)
    const turnKey = turnKeys[index]
    const reply = turnKey === undefined ? undefined : replies.get(turnKey)
    entries.push({
      itemId: message.id,
      sequence,
      preview: preview.text,
      imageCount: preview.imageCount,
      ...(turnKey === undefined || turnKey === message.id ? {} : { turnKey }),
      ...(reply === undefined ? {} : { reply })
    })
  }
  return entries
}
