import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField
} from './agent-status-field-normalization'
import {
  AGENT_JOURNAL_MESSAGE_SEND_MODES,
  type AgentJournalMessageSendMode,
  type AgentJournalRenderItem,
  type AgentJournalSubmission,
  type AgentJournalTurnOutcome
} from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import { describeToolInput } from './native-chat-tool-summary'
import { statusStructuredAgentSessionToolCall } from './structured-agent-session-live-turn'
import {
  hasStructuredAgentSessionRequest,
  latestStructuredAgentSessionRequest,
  type StructuredAgentSessionLatestRequest
} from './structured-agent-session-latest-request'
import {
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock
} from './structured-agent-session-tool-call-block'

import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { sha256 } from './sha256'
import { structuredAgentSessionStatusStartedAt } from './structured-agent-session-status-started-at'
import { owesStructuredAgentSessionWork } from './structured-agent-session-owed-work'

// Re-exported so the live-turn readers' and the unanswered-send rule's existing consumers keep one
// import site.
export {
  activeStructuredAgentSessionTurnId,
  newestStructuredAgentSessionTurn
} from './structured-agent-session-live-turn'
export { hasUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

function boundedText(payload: { head: string; truncated: boolean; byteLength: number }): string {
  return payload.truncated ? `${payload.head}\n… (${payload.byteLength} bytes)` : payload.head
}

/** The markers a clipped payload carries in its own text, anchored to the end
 *  so nothing that merely looks like one inside the body can match. */
const BOUNDED_TEXT_MARKERS = [
  /\n… \(\d+ bytes\)$/,
  /\n\[Orca: output truncated — \d+ bytes total, digest [0-9a-f]+\]$/
]

/** Recovers the clipped body from a bounded payload's text, and says whether a
 *  marker was there. A reader that treats the text as content renders the
 *  marker as a line of it — with a line number, which reads as a real position
 *  in the file — and reports the body as complete. */
export function stripBoundedTextMarker(text: string): { text: string; truncated: boolean } {
  const stripped = BOUNDED_TEXT_MARKERS.reduce((value, marker) => value.replace(marker, ''), text)
  return { text: stripped, truncated: stripped.length !== text.length }
}

function itemBlocks(item: AgentJournalRenderItem): {
  role: NativeChatMessage['role']
  blocks: NativeChatBlock[]
} | null {
  const body = item.body
  if (body.kind === 'message') {
    return { role: body.role, blocks: body.blocks }
  }
  if (isStructuredAgentSessionToolAction(body)) {
    const call = structuredAgentSessionToolCallBlock(body)
    if (body.kind === 'diff') {
      return {
        role: 'assistant',
        blocks: [call, { type: 'tool-result', output: boundedText(body.patch) }]
      }
    }
    return {
      role: 'assistant',
      blocks: [
        call,
        ...(body.output
          ? [
              {
                type: 'tool-result' as const,
                output: boundedText(body.output),
                isError: body.state === 'failed'
              }
            ]
          : [])
      ]
    }
  }
  if (body.kind === 'approval') {
    if (body.resolution.state === 'pending') {
      return null
    }
    return {
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: `${body.title}\n${body.detail ?? ''}\n${body.resolution.state}`.trim()
        }
      ]
    }
  }
  if (body.kind === 'question') {
    if (body.resolution.state === 'pending') {
      return null
    }
    const choices = body.options.map((option) => option.label).join(' · ')
    return {
      role: 'system',
      blocks: [{ type: 'text', text: `${body.question}\n${choices}`.trim() }]
    }
  }
  // A turn record is timing, not content; a kind this build does not know is
  // never painted as text either, so a newer host can add kinds freely.
  if (body.kind !== 'status' || body.turnLifecycle) {
    return null
  }
  return {
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: body.text,
        ...(body.presentation !== undefined ? { presentation: body.presentation } : {}),
        ...(body.tone !== undefined ? { tone: body.tone } : {}),
        ...(body.providerFrame ? { providerFrame: body.providerFrame } : {})
      }
    ]
  }
}

function isAgentJournalMessageSendMode(value: string): value is AgentJournalMessageSendMode {
  return AGENT_JOURNAL_MESSAGE_SEND_MODES.some((mode) => mode === value)
}

const projectedItems = new WeakMap<AgentJournalRenderItem, NativeChatMessage | null>()

/** Deliberately NOT scoped by producer: the transcript shows every agent's
 *  output. The line this module draws is that the transcript renders every item,
 *  while every "what is this agent doing right now" scan renders only the
 *  session's own agent's. */
export function projectStructuredItemsToNativeChat(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  const messages: NativeChatMessage[] = []
  items.forEach((item) => {
    const projected = projectStructuredItemToNativeChat(item)
    if (projected) {
      messages.push(projected)
    }
  })
  return messages
}

export function projectStructuredItemToNativeChat(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  const cached = projectedItems.get(item)
  if (cached !== undefined) {
    return cached
  }
  // Reducer updates replace journal items, so unchanged rows keep their render caches.
  const projected = itemBlocks(item)
  const sentAs = item.body.kind === 'message' ? item.body.sentAs : undefined
  const message: NativeChatMessage | null = projected
    ? {
        id: item.itemId,
        role: projected.role,
        blocks: projected.blocks,
        timestamp: item.observedAt,
        source: 'transcript',
        // A send mode this build cannot name renders as an ordinary message.
        ...(sentAs !== undefined && isAgentJournalMessageSendMode(sentAs) ? { sentAs } : {})
      }
    : null
  projectedItems.set(item, message)
  return message
}

export type StructuredAgentSessionProjectedStatus = 'working' | 'attention' | 'idle'

export function structuredAgentSessionTabId(sessionId: string): string {
  return `structured-agent-session-${sessionId}`
}

export function projectStructuredAgentSessionStatus(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null
): StructuredAgentSessionProjectedStatus {
  if (
    items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
  ) {
    return 'attention'
  }
  return owesStructuredAgentSessionWork(items, submissions, currentFence) ? 'working' : 'idle'
}

function messageProse(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The newest prompt the session's own user turn carries, as the sidebar quotes
 *  it. Scoped to root rows for the same reason the assistant line is: a provider
 *  that journals a subagent's own prompt would otherwise requote it as the
 *  session's. */
export function latestStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  const body = latestStructuredAgentSessionUserItem(items)?.body
  return body?.kind === 'message' ? messageProse(body.blocks) : ''
}

export function latestStructuredAgentSessionUserItem(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item?.body.kind === 'message' &&
      item.body.role === 'user' &&
      isRootAgentJournalItem(item)
    ) {
      return item
    }
  }
  return null
}

/** The newest prose THE SESSION'S OWN AGENT wrote in the latest user turn — not a
 *  subagent's, whose rows share this journal and are usually the newer ones while
 *  a child runs. Tool-only assistant items are skipped; the user boundary clears
 *  prose from the preceding turn. */
export function latestStructuredAgentSessionAssistantMessage(
  items: readonly AgentJournalRenderItem[]
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    if (!isRootAgentJournalItem(item)) {
      continue
    }
    if (body?.kind === 'message' && body.role === 'user') {
      return ''
    }
    if (body?.kind === 'message' && body.role === 'assistant') {
      const prose = messageProse(body.blocks)
      if (prose.trim()) {
        return prose
      }
    }
  }
  return ''
}

/** The activity fields a sidebar row shows beside the prompt, named as the agent-status
 *  entry names them so the client can hand them straight to a row. */
export type StructuredAgentSessionStatusProjection = {
  status: StructuredAgentSessionProjectedStatus | null
  latestPrompt: string
  /** Present only while a turn is running — see showsAgentToolPreview, which reads
   *  these on any state that carries them. */
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  /** The latest request's verdict: its turn's, or `failure` for a send the agent or its start
   *  refused. Present only while `status` is idle. */
  turnOutcome?: AgentJournalTurnOutcome
  statusStartedAt?: number
}

/** One projection shared by host and client: null status means "no turn yet", not idle.
 *  Every text field is bounded to the same preview an agent-status row carries — a send
 *  admits 256 KB, and one status frame carries every retained session at once. The
 *  assistant line is bounded harder than the hook field it stands in for (a preview, not
 *  the 8 KB body): a streamed reply re-projects on every journal checkpoint, so the frame
 *  has to stay small even though the row only ever renders one line of it. */
export function projectStructuredAgentSessionStatusSummary(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null
): StructuredAgentSessionStatusProjection {
  return projectStructuredAgentSessionStatusState(items, submissions, currentFence).summary
}

/** The summary plus the latest request it was read from, whatever the status, so the host's
 *  completion feed follows the same request the row reports without scanning again. */
export function projectStructuredAgentSessionStatusState(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null
): {
  summary: StructuredAgentSessionStatusProjection
  latestRequest: StructuredAgentSessionLatestRequest | null
  /** Whether a running turn or an unanswered send is still owed, even beneath a pending prompt. */
  owesWork: boolean
} {
  if (!hasStructuredAgentSessionRequest(items, submissions, currentFence)) {
    return { summary: { status: null, latestPrompt: '' }, latestRequest: null, owesWork: false }
  }
  const status = projectStructuredAgentSessionStatus(items, submissions, currentFence)
  const statusToolCall = status === 'working' ? statusStructuredAgentSessionToolCall(items) : null
  const toolName = statusToolCall
    ? normalizeOptionalField(statusToolCall.name, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
    : undefined
  const toolInput = statusToolCall
    ? normalizeOptionalField(
        describeToolInput(statusToolCall.input),
        AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
      )
    : undefined
  const lastAssistantMessage = normalizeOptionalField(
    latestStructuredAgentSessionAssistantMessage(items),
    AGENT_STATUS_MAX_FIELD_LENGTH
  )
  const latestRequest = latestStructuredAgentSessionRequest(items, submissions)
  // A verdict is a fact about a finished request: only an idle session has one to report.
  const request = status === 'idle' ? latestRequest : null
  const turnOutcome = request?.outcome
  const statusStartedAt = structuredAgentSessionStatusStartedAt(
    status,
    items,
    submissions,
    currentFence,
    request
  )
  return {
    latestRequest,
    owesWork: status !== 'idle' && owesStructuredAgentSessionWork(items, submissions, currentFence),
    summary: {
      status,
      latestPrompt: normalizePromptField(latestStructuredAgentSessionPrompt(items)),
      ...(toolName ? { toolName } : {}),
      ...(toolInput ? { toolInput } : {}),
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
      ...(turnOutcome ? { turnOutcome } : {}),
      ...(statusStartedAt !== undefined ? { statusStartedAt } : {})
    }
  }
}

export function structuredAgentSessionPaneKey(tabId: string, sessionId: string): string {
  const bytes = sha256(new TextEncoder().encode(sessionId))
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const leaf = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return `${tabId}:${leaf}`
}
