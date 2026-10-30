import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField
} from './agent-status-field-normalization'
import {
  AGENT_JOURNAL_MESSAGE_SEND_MODES,
  AGENT_JOURNAL_MESSAGE_STATES,
  type AgentJournalMessageItem,
  type AgentJournalMessageSendMode,
  type AgentJournalRenderItem,
  type AgentJournalSubmission
} from './agent-session-journal-types'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import { agentJournalToolCallLifecycle } from './agent-journal-tool-call-lifecycle'
import { agentJournalLinkageFields } from './agent-session-journal-producer'
import { structuredAgentSessionStatusBlock } from './structured-agent-session-status-block'
import { agentJournalItemRowOrigin } from './agent-session-journal-position'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import { describeToolInput } from './native-chat/tools/native-chat-tool-summary'
import { statusStructuredAgentSessionToolCall } from './structured-agent-session-live-turn'
import {
  hasStructuredAgentSessionRequest,
  latestStructuredAgentSessionAssistantMessage,
  latestStructuredAgentSessionPrompt,
  latestStructuredAgentSessionRequest,
  type StructuredAgentSessionLatestRequest
} from './structured-agent-session-latest-request'
import {
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock
} from './structured-agent-session-tool-call-block'

import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { sha256 } from './sha256'
import { readAgentMessageSource } from './agent-session/agent-session-message-source'
import { structuredAgentSessionStatusStartedAt } from './structured-agent-session-status-started-at'
import { owesStructuredAgentSessionWork } from './structured-agent-session-owed-work'
import type { StructuredAgentSessionWorkScope } from './structured-agent-session-main-agent-working'
import { agentSessionCurrentContextRows } from './agent-session-context-clear'
import { nativeChatStatusTurnOutcome } from './native-chat/native-chat-orca-stop-cut'

// Keep existing live-turn/unanswered-send consumers on one import path.
export {
  activeStructuredAgentSessionTurnId,
  newestStructuredAgentSessionTurn
} from './structured-agent-session-live-turn'
export { hasUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

/** Only transport-clipped output has a fetchable remainder; older saved truncations have none. */
function toolResult(
  item: AgentJournalRenderItem,
  payload: { head: string; truncated: boolean; byteLength: number },
  callId: string | undefined
) {
  return {
    type: 'tool-result' as const,
    output: payload.truncated ? `${payload.head}\n… (${payload.byteLength} bytes)` : payload.head,
    callId,
    ...(item.shortened && payload.truncated ? { fullOutputItemId: item.itemId } : {})
  }
}

/** Anchor truncation markers at the end so body lookalikes remain content. */
const BOUNDED_TEXT_MARKERS = [
  /\n\u2026 \(\d+ bytes\)$/,
  /\n\[Orca: output truncated \u2014 \d+ bytes total, digest [0-9a-f]+\]$/
]

/** Strip clipping markers and retain truncation state; otherwise file viewers render the marker as a real numbered line and claim completeness. */
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
    const call = structuredAgentSessionToolCallBlock(body, item.itemId)
    // Call/result share one row; use its call ID to pair them.
    const { callId } = call
    if (body.kind === 'diff') {
      return { role: 'assistant', blocks: [call, toolResult(item, body.patch, callId)] }
    }
    return {
      role: 'assistant',
      blocks: [
        call,
        ...(body.output
          ? [
              {
                ...toolResult(item, body.output, callId),
                // Interrupted output is not an error reported by the tool.
                isError: agentJournalToolCallLifecycle(body) === 'failed'
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
  // Turn records are timing only; unknown newer-host kinds must not become text.
  if (body.kind !== 'status' || body.turnLifecycle) {
    return null
  }
  return {
    role: 'system',
    blocks: [structuredAgentSessionStatusBlock(body, item.turnScope, item.itemId)]
  }
}

function isAgentJournalMessageSendMode(value: string): value is AgentJournalMessageSendMode {
  return AGENT_JOURNAL_MESSAGE_SEND_MODES.some((mode) => mode === value)
}

/** A state this build cannot name reads as completed: a newer host's row is never live here. */
function messageLifecycle(
  body: AgentJournalMessageItem
): Pick<NativeChatMessage, 'state' | 'completedAt'> {
  const state: string | undefined = body.state
  if (state === undefined) {
    return {}
  }
  return {
    state: AGENT_JOURNAL_MESSAGE_STATES.find((known) => known === state) ?? 'completed',
    ...(body.completedAt !== undefined ? { completedAt: body.completedAt } : {})
  }
}

const projectedItems = new WeakMap<AgentJournalRenderItem, NativeChatMessage | null>()

/** Render all producers and retain linkage for child sections; current-status readers separately scope to the root agent. */
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
  const lifecycle = item.body.kind === 'message' ? messageLifecycle(item.body) : {}
  const command = item.body.kind === 'message' ? item.body.command : undefined
  // Validate wire-origin sender fields from any host version.
  const from = item.body.kind === 'message' ? readAgentMessageSource(item.body.from) : undefined
  const message: NativeChatMessage | null = projected
    ? {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: projected.role,
        blocks: projected.blocks,
        // A send mode this build cannot name renders as an ordinary message.
        ...(sentAs !== undefined && isAgentJournalMessageSendMode(sentAs) ? { sentAs } : {}),
        ...lifecycle,
        ...(command ? { command } : {}),
        ...(from && projected.role === 'user' ? { from } : {}),
        ...(item.shortened && item.body.kind === 'message' ? { shortened: true } : {})
      }
    : null
  projectedItems.set(item, message)
  return message
}

export type StructuredAgentSessionProjectedStatus = 'working' | 'attention' | 'idle'

export function structuredAgentSessionTabId(sessionId: string): string {
  return `structured-agent-session-${sessionId}`
}

/** Ignore prompts from ended generations when the host scope proves no child can answer them. */
function pendingStructuredAgentSessionPrompt(
  scope?: StructuredAgentSessionWorkScope
): (item: AgentJournalRenderItem) => boolean {
  return (item) =>
    (item.body.kind === 'approval' || item.body.kind === 'question') &&
    item.body.resolution.state === 'pending' &&
    (!scope || scope.isCurrentItem(item.itemId))
}

/** Host scope excludes ended-generation work from Working/attention. */
export function projectStructuredAgentSessionStatus(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): StructuredAgentSessionProjectedStatus {
  ;({ items, submissions } = agentSessionCurrentContextRows(items, submissions))
  if (items.some(pendingStructuredAgentSessionPrompt(scope))) {
    return 'attention'
  }
  return owesStructuredAgentSessionWork(items, submissions, currentFence, scope)
    ? 'working'
    : 'idle'
}

/** Name sidebar activity fields like agent-status entries for direct row consumption. */
export type StructuredAgentSessionStatusProjection = {
  status: StructuredAgentSessionProjectedStatus | null
  latestPrompt: string
  /** Present only while a turn is running — see showsAgentToolPreview, which reads
   *  these on any state that carries them. */
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  /** Idle-only latest-request verdict: turn outcome, host-observed end if absent, or refused-send failure. */
  turnOutcome?: AgentTurnOutcome
  statusStartedAt?: number
}

/** Share host/client previews; null status means no turn yet. Bound text because sends admit 256 KB and status frames include all sessions;
 * bound assistant prose below the hook’s 8 KB body because every streaming checkpoint republishes a one-line preview. */
export function projectStructuredAgentSessionStatusSummary(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null
): StructuredAgentSessionStatusProjection {
  return projectStructuredAgentSessionStatusState(items, submissions, currentFence).summary
}

/** Return the summary and its request together so the host completion feed cannot diverge or rescan. */
export function projectStructuredAgentSessionStatusState(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): {
  summary: StructuredAgentSessionStatusProjection
  latestRequest: StructuredAgentSessionLatestRequest | null
  /** Whether a running turn or an unanswered send is still owed, even beneath a pending prompt. */
  owesWork: boolean
  /** Item ids of the approvals and questions waiting on the user: what makes the status `attention`. */
  pendingPromptIds: string[]
} {
  const latestPrompt = latestStructuredAgentSessionPrompt(items)
  if (!hasStructuredAgentSessionRequest(items, submissions, currentFence)) {
    return {
      summary: { status: null, latestPrompt: '' },
      latestRequest: null,
      owesWork: false,
      pendingPromptIds: []
    }
  }
  ;({ items, submissions } = agentSessionCurrentContextRows(items, submissions))
  const status = projectStructuredAgentSessionStatus(items, submissions, currentFence, scope)
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
  // Only idle sessions report a finished-request verdict.
  const request = status === 'idle' ? latestRequest : null
  const turnOutcome = nativeChatStatusTurnOutcome(request, items, submissions)
  const statusStartedAt = structuredAgentSessionStatusStartedAt(
    status,
    items,
    submissions,
    currentFence,
    request
  )
  return {
    latestRequest,
    owesWork:
      status !== 'idle' && owesStructuredAgentSessionWork(items, submissions, currentFence, scope),
    pendingPromptIds:
      status === 'attention'
        ? items.filter(pendingStructuredAgentSessionPrompt(scope)).map((item) => item.itemId)
        : [],
    summary: {
      status,
      latestPrompt: normalizePromptField(latestPrompt),
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
