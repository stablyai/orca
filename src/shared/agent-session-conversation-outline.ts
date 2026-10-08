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
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from './native-chat-row-content'
import { iterateProcessOutputLines } from './process-output-field-scanner'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from './native-chat-transcript-projection'
import { nativeChatTurnMembership } from './native-chat-turn-membership'

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
  /** The message that opened this one's turn, when this one did not: a steer sent
   *  into a running turn. Absent from a host that predates the field. */
  turnKey?: string
  /** What the agent answered, as preview prose. Absent when it said nothing, from a
   *  host that predates the field, or when the host dropped replies to fit. */
  reply?: string
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

/** What the agent answered each turn with, by turn key: the prose of the turn's
 *  last assistant row that has any. Turns are the transcript's own (`turnKeys` from
 *  `nativeChatTurnMembership`), so a steer or a queued prompt cannot cut a reply
 *  short. `only` limits the read to one turn. */
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

/** User messages that draw a transcript row, in transcript order. Projected over the
 *  whole journal, not user items alone: whether a user row survives depends on its
 *  neighbours (a harness sidecar folds into the turn before it), and its order is
 *  its journal position. Previews are uncut; the reply bound owns length. */
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
    // Unchanged on the wire: a desktop's rejected rows tick once their page is loaded.
    projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: false })
  )
  const { turnKeys } = nativeChatTurnMembership(transcript, { items, submissions })
  const replies = nativeChatTurnReplyPreviews(transcript, turnKeys)
  for (const [index, message] of transcript.entries()) {
    const sequence = sequences.get(message.id)
    if (
      sequence === undefined ||
      stopped.has(message.id) ||
      message.role !== 'user' ||
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
