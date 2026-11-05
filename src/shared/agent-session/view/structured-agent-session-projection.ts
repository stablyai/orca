import { nativeChatStatusTurnOutcomeSteps } from '../../native-chat/native-chat-orca-stop-cut'
import { structuredAgentSessionStatusStartedAtSteps } from './structured-agent-session-status-started-at'
import {
  latestStructuredAgentSessionRequestSteps,
  latestStructuredAgentSessionAssistantMessageSteps,
  hasStructuredAgentSessionRequestSteps,
  latestStructuredAgentSessionPromptSteps
} from '../requests/structured-agent-session-latest-request'
import { statusStructuredAgentSessionToolCallSteps } from './structured-agent-session-live-turn'
import { owesStructuredAgentSessionWorkSteps } from './structured-agent-session-owed-work'
import { agentSessionCurrentContextRowsSteps } from '../agent-session-context-clear'
import { finishAgentSessionSteps } from '../agent-session-projection-steps'
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  normalizeOptionalField,
  normalizePromptField,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
} from '../../agent-status/contracts/agent-status-field-normalization'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { AgentTurnOutcome } from '../../agent-status/lifecycle/agent-turn-outcome'

import { AGENT_STATUS_TOOL_NAME_MAX_LENGTH } from '../../agent-status/contracts/agent-status-types'
import { describeToolInput } from '../../native-chat/tools/native-chat-tool-summary'

import type { StructuredAgentSessionLatestRequest } from '../requests/structured-agent-session-latest-request'

import { sha256 } from '../../sha256'

import type { StructuredAgentSessionWorkScope } from './structured-agent-session-main-agent-working'

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
  return finishAgentSessionSteps(
    projectStructuredAgentSessionStatusSteps(items, submissions, currentFence, scope)
  )
}

export function* projectStructuredAgentSessionStatusSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): Generator<void, StructuredAgentSessionProjectedStatus> {
  ;({ items, submissions } = yield* agentSessionCurrentContextRowsSteps(items, submissions))
  const pending = pendingStructuredAgentSessionPrompt(scope)
  for (const item of items) {
    yield
    if (pending(item)) {
      return 'attention'
    }
  }
  return (yield* owesStructuredAgentSessionWorkSteps(items, submissions, currentFence, scope))
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
  return finishAgentSessionSteps(
    projectStructuredAgentSessionStatusStateSteps(items, submissions, currentFence, scope)
  )
}

export function* projectStructuredAgentSessionStatusStateSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = [],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): Generator<
  void,
  {
    summary: StructuredAgentSessionStatusProjection
    latestRequest: StructuredAgentSessionLatestRequest | null
    /** Whether a running turn or an unanswered send is still owed, even beneath a pending prompt. */
    owesWork: boolean
    /** Item ids of the approvals and questions waiting on the user: what makes the status `attention`. */
    pendingPromptIds: string[]
  }
> {
  const latestPrompt = yield* latestStructuredAgentSessionPromptSteps(items)
  if (!(yield* hasStructuredAgentSessionRequestSteps(items, submissions, currentFence))) {
    return {
      summary: { status: null, latestPrompt: '' },
      latestRequest: null,
      owesWork: false,
      pendingPromptIds: []
    }
  }
  ;({ items, submissions } = yield* agentSessionCurrentContextRowsSteps(items, submissions))
  const status = yield* projectStructuredAgentSessionStatusSteps(
    items,
    submissions,
    currentFence,
    scope
  )
  const statusToolCall =
    status === 'working' ? yield* statusStructuredAgentSessionToolCallSteps(items) : null
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
    yield* latestStructuredAgentSessionAssistantMessageSteps(items),
    AGENT_STATUS_MAX_FIELD_LENGTH
  )
  const latestRequest = yield* latestStructuredAgentSessionRequestSteps(items, submissions)
  // Only idle sessions report a finished-request verdict.
  const request = status === 'idle' ? latestRequest : null
  const turnOutcome = yield* nativeChatStatusTurnOutcomeSteps(request, items, submissions)
  const statusStartedAt = yield* structuredAgentSessionStatusStartedAtSteps(
    status,
    items,
    submissions,
    currentFence,
    request
  )
  const pendingPromptIds: string[] = []
  if (status === 'attention') {
    const pending = pendingStructuredAgentSessionPrompt(scope)
    for (const item of items) {
      if (pending(item)) {
        pendingPromptIds.push(item.itemId)
      }
      yield
    }
  }
  return {
    latestRequest,
    owesWork:
      status !== 'idle' &&
      (yield* owesStructuredAgentSessionWorkSteps(items, submissions, currentFence, scope)),
    pendingPromptIds,
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

export {
  projectStructuredItemsToNativeChat,
  projectStructuredItemToNativeChat,
  stripBoundedTextMarker
} from './structured-agent-session-item-projection'
