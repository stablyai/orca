import { memoizeStringResult } from '../../collections/string-result-cache'
import { isAgentSessionSlotTabId } from './agent-session-slot-tab-id'
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
} from '../../agent-status/contracts/agent-status-field-normalization'
import {
  AGENT_JOURNAL_MESSAGE_SEND_MODES,
  AGENT_JOURNAL_MESSAGE_STATES,
  type AgentJournalMessageItem,
  type AgentJournalMessageSendMode,
  type AgentJournalRenderItem,
  type AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { AgentTurnOutcome } from '../../agent-status/lifecycle/agent-turn-outcome'
import type { AgentSessionAwaitedQuestion, AgentSessionStatusSummary } from '../agent-session-wire'
import { structuredAgentSessionAwaitedPrompt } from './structured-agent-session-awaited-prompt'
import { agentJournalLinkageFields } from '../journal/agent-session-journal-producer'
import { itemBlocks } from './structured-agent-session-item-blocks'
import { agentJournalItemRowOrigin } from '../journal/agent-session-journal-position'
import { AGENT_STATUS_TOOL_NAME_MAX_LENGTH } from '../../agent-status/contracts/agent-status-types'
import { describeToolInput } from '../../native-chat/tools/native-chat-tool-summary'
import { statusStructuredAgentSessionToolCall } from './structured-agent-session-live-turn'
import {
  hasStructuredAgentSessionRequest,
  latestStructuredAgentSessionPrompt,
  latestStructuredAgentSessionRequest,
  type StructuredAgentSessionLatestRequest
} from '../requests/structured-agent-session-latest-request'
import { currentStructuredAgentSessionAnswer } from '../requests/structured-agent-session-current-answer'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { sha256 } from '../../hashing/sha256'
import { nativeChatMessageSenderFields } from '../../native-chat-message-sender-fields'
import { tookOverGoalBlocks } from '../../native-chat/took-over-notice'
import { structuredAgentSessionStatusStartedAt } from './structured-agent-session-status-started-at'
import { owesStructuredAgentSessionWork } from './structured-agent-session-owed-work'
import type { StructuredAgentSessionWorkScope } from './structured-agent-session-main-agent-working'
import {
  agentSessionCurrentContextBody,
  agentSessionCurrentContextRows
} from '../conversation-context/agent-session-context-clear'
import { nativeChatStatusTurnOutcome } from '../../native-chat/transcript/continuation/native-chat-orca-stop-cut'

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
  const message: NativeChatMessage | null = projected
    ? {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: projected.role,
        blocks: tookOverGoalBlocks(item.body) ?? projected.blocks,
        // A send mode this build cannot name renders as an ordinary message.
        ...(sentAs !== undefined && isAgentJournalMessageSendMode(sentAs) ? { sentAs } : {}),
        ...lifecycle,
        ...(command ? { command } : {}),
        ...nativeChatMessageSenderFields(item.body, projected.role),
        ...(projected.drawnMarkdown !== undefined
          ? { drawnMarkdown: projected.drawnMarkdown }
          : {}),
        ...(item.shortened && item.body.kind === 'message' ? { shortened: true } : {}),
        journalRevision: item.revision
      }
    : null
  projectedItems.set(item, message)
  return message
}

export type StructuredAgentSessionProjectedStatus = 'working' | 'attention' | 'idle'

/** Legacy tab id of chats opened before slot ids were minted; still their pane/status address. */
export function structuredAgentSessionTabId(sessionId: string): string {
  return `structured-agent-session-${sessionId}`
}

/** An approval or question still waiting on the user; with the host's scope, never one from an ended
 *  generation, which no child can answer. */
export function pendingStructuredAgentSessionPrompt(
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
  return items.some(pendingStructuredAgentSessionPrompt(scope))
    ? 'attention'
    : owesStructuredAgentSessionWork(items, submissions, currentFence, scope)
      ? 'working'
      : 'idle'
}

/** Name sidebar activity fields like agent-status entries for direct row consumption. */
export type StructuredAgentSessionStatusProjection = Pick<
  AgentSessionStatusSummary,
  'awaitsApproval' | 'awaitsBlockingQuestion' | 'attentionAsksOnlyQuestions'
> & {
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
  /** The newest async question still waiting for the person's next message; set by the host's
   *  journal reads and folded with the person's Skip into the published `awaitsAnswer`. */
  openAsyncQuestion?: AgentSessionAwaitedQuestion
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
  scope?: StructuredAgentSessionWorkScope,
  /** An indexed read of these rows by id, so per-write status finds command turns without scanning history. */
  itemOf?: (itemId: string) => AgentJournalRenderItem | null,
  /** A bot's session, whose quiet-marker answers the preview skips. */
  botSession = false
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
  const context = agentSessionCurrentContextRows(items, submissions)
  ;({ items, submissions } = context)
  const bodyOf = itemOf && agentSessionCurrentContextBody(itemOf, context.sequence)
  const status = projectStructuredAgentSessionStatus(items, submissions, currentFence, scope)
  const statusToolCall = status === 'working' ? statusStructuredAgentSessionToolCall(items) : null
  const toolName = normalizeOptionalField(statusToolCall?.name, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
  const toolInput = statusToolCall
    ? normalizeOptionalField(
        describeToolInput(statusToolCall.input),
        AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
      )
    : undefined
  const workingSends = status === 'working' ? submissions : []
  const lastAssistantMessage = normalizeOptionalField(
    currentStructuredAgentSessionAnswer(items, workingSends, bodyOf, botSession, currentFence),
    AGENT_STATUS_MAX_FIELD_LENGTH
  )
  const latestRequest = latestStructuredAgentSessionRequest(items, submissions, bodyOf)
  // Only idle sessions report a finished-request verdict.
  const request = status === 'idle' ? latestRequest : null
  const turnOutcome = nativeChatStatusTurnOutcome(request, items, submissions, bodyOf)
  const statusStartedAt = structuredAgentSessionStatusStartedAt(
    status,
    items,
    submissions,
    currentFence,
    request
  )
  const pending =
    status === 'attention' ? items.filter(pendingStructuredAgentSessionPrompt(scope)) : []
  return {
    latestRequest,
    owesWork:
      status !== 'idle' && owesStructuredAgentSessionWork(items, submissions, currentFence, scope),
    pendingPromptIds: pending.map((item) => item.itemId),
    summary: {
      status,
      latestPrompt: normalizePromptField(latestPrompt),
      ...(toolName ? { toolName } : {}),
      ...(toolInput ? { toolInput } : {}),
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
      ...(turnOutcome ? { turnOutcome } : {}),
      ...(statusStartedAt !== undefined ? { statusStartedAt } : {}),
      ...structuredAgentSessionAwaitedPrompt(pending)
    }
  }
}

// Why: callers walk every live chat, and a FIFO smaller than that set misses on every pass.
const MAX_MEMOIZED_PANE_LEAVES = 32_768
const structuredAgentSessionPaneLeaf = memoizeStringResult((sessionId: string): string => {
  const bytes = sha256(new TextEncoder().encode(sessionId))
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}, MAX_MEMOIZED_PANE_LEAVES)

/** The tab id a chat's pane key names: status, attention and orchestration rows still address a
 *  minted slot's chat by its session's legacy id. */
export function structuredAgentSessionAddressTabId(tabId: string, sessionId: string): string {
  return isAgentSessionSlotTabId(tabId) ? structuredAgentSessionTabId(sessionId) : tabId
}

export function structuredAgentSessionPaneKey(tabId: string, sessionId: string): string {
  return `${structuredAgentSessionAddressTabId(tabId, sessionId)}:${structuredAgentSessionPaneLeaf(sessionId)}`
}
