import { extractPendingMessageReplyAsk } from './native-chat/input/native-chat-ask'
import type { MessageQuestionOccurrence } from './message-question-occurrence'
import { messageQuestionPrompt, type MessageQuestionView } from './message-question-occurrence'
import type { NativeChatMessage } from './native-chat-types'
import type { CurrentRequestsPayload, SourceContext } from './agent-session-current-requests-wire'
import { agentSessionCurrentContextRows } from './agent-session-context-clear'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import type { AgentSessionCurrentRequestsMarker } from './agent-session-current-requests-wire'
import {
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_V2
} from './agent-session-current-requests-capability'

export type AgentSessionCurrentRequestsState = {
  asyncQuestions?: readonly MessageQuestionOccurrence[]
  requestContext?: SourceContext
  currentRequests?: AgentJournalRenderItem[]
  requestMarker?: AgentSessionCurrentRequestsMarker
  /** Qualification survives contact loss alongside the last complete answer. */
  requestAuthority?: AgentSessionCurrentRequestsMarker
  asyncQuestionAuthority?: AgentSessionCurrentRequestsMarker
}

export function currentRequestsState(
  state: AgentSessionCurrentRequestsState
): AgentSessionCurrentRequestsState {
  return {
    currentRequests: state.currentRequests,
    asyncQuestions: state.asyncQuestions,
    requestContext: state.requestContext,
    requestMarker: state.requestMarker,
    requestAuthority: state.requestAuthority,
    asyncQuestionAuthority: state.asyncQuestionAuthority
  }
}

export function applyCurrentRequestsMarker(
  state: AgentSessionCurrentRequestsState,
  marker: AgentSessionCurrentRequestsMarker
): AgentSessionCurrentRequestsState {
  if (
    marker.contract !== AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY &&
    marker.contract !== AGENT_SESSION_CURRENT_REQUESTS_V2
  ) {
    return state
  }
  const prior = state.requestMarker ?? state.requestAuthority
  if (prior?.publisher === marker.publisher && marker.revision <= prior.revision) {
    return state
  }
  const sameSource = prior !== undefined && prior.sessionId === marker.sessionId
  return {
    currentRequests: sameSource ? state.currentRequests : [],
    asyncQuestions:
      marker.contract === AGENT_SESSION_CURRENT_REQUESTS_V2
        ? sameSource
          ? state.asyncQuestions
          : undefined
        : undefined,
    requestContext: sameSource ? state.requestContext : undefined,
    requestAuthority: sameSource ? state.requestAuthority : undefined,
    asyncQuestionAuthority: sameSource ? state.asyncQuestionAuthority : undefined,
    requestMarker: marker
  }
}

/** Install only a fully validated envelope admitted by the current captured resource. */
export function installCurrentRequestsCompletion(
  state: AgentSessionCurrentRequestsState,
  marker: AgentSessionCurrentRequestsMarker,
  items: AgentJournalRenderItem[],
  payload?: CurrentRequestsPayload
): AgentSessionCurrentRequestsState {
  if (marker.version !== state.requestMarker?.version) {
    return state
  }
  const sameContext =
    payload?.context.sessionId === state.requestContext?.sessionId &&
    payload?.context.boundary === state.requestContext?.boundary
  const asyncQuestions = payload
    ? payload.asyncQuestions === null
      ? sameContext
        ? state.asyncQuestions
        : undefined
      : payload.asyncQuestions
    : undefined
  const asyncQuestionAuthority = payload?.asyncQuestions != null ? marker : undefined
  if (
    state.requestAuthority?.version === marker.version &&
    state.asyncQuestionAuthority?.version === asyncQuestionAuthority?.version &&
    (payload === undefined || sameContext)
  ) {
    return state
  }
  const stableBlocking =
    state.requestAuthority?.epoch === marker.epoch &&
    state.requestAuthority?.owner === marker.owner &&
    state.currentRequests?.length === items.length &&
    items.every(
      (item, index) =>
        item.itemId === state.currentRequests?.[index].itemId &&
        item.revision === state.currentRequests[index].revision
    )
      ? state.currentRequests
      : items
  return {
    ...currentRequestsState(state),
    currentRequests: stableBlocking,
    asyncQuestions,
    requestContext: sameContext ? state.requestContext : payload?.context,
    requestAuthority: marker,
    asyncQuestionAuthority
  }
}

export function hasCompleteBlockingRequests(state: AgentSessionCurrentRequestsState): boolean {
  return (
    state.requestMarker !== undefined &&
    state.requestMarker.version === state.requestAuthority?.version
  )
}

/** Openings assert support; an omitted field later only means unchanged. */
export function currentRequestsAfterEvent(
  state: AgentSessionCurrentRequestsState & { fence: number | null; epoch: string | null },
  event: Exclude<AgentSessionSubscribeEvent, { type: 'end' }>,
  opensSubscription: boolean
): AgentSessionCurrentRequestsState {
  if (event.currentRequests) {
    return applyCurrentRequestsMarker(state, event.currentRequests)
  }
  if (opensSubscription) {
    return state.requestMarker
      ? {
          ...currentRequestsState(state),
          requestAuthority: undefined,
          asyncQuestionAuthority: undefined
        }
      : currentRequestsState({})
  }
  const epoch = event.type === 'batch' ? event.batch.cursor.epoch : event.page.epoch
  if (
    state.requestMarker &&
    (epoch !== state.epoch || (event.fence !== undefined && event.fence !== state.fence))
  ) {
    return {
      currentRequests: [],
      asyncQuestions: undefined,
      requestContext: undefined,
      requestMarker: state.requestMarker,
      requestAuthority: undefined,
      asyncQuestionAuthority: undefined
    }
  }
  return currentRequestsState(state)
}

export type AgentSessionCurrentRequest = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

/** Complete operational records own controls independently of historical pages. */
export function selectAgentSessionCurrentRequests(state: {
  items: readonly AgentJournalRenderItem[]
  currentRequests?: readonly AgentJournalRenderItem[]
}): AgentSessionCurrentRequest[] {
  return (state.currentRequests ?? agentSessionCurrentContextRows(state.items).items).filter(
    (item): item is AgentSessionCurrentRequest =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
}

/** A negotiated feed owns async controls even before its first complete read. */
export function currentMessageQuestionView(
  state: AgentSessionCurrentRequestsState
): MessageQuestionView | undefined {
  return state.requestMarker?.contract === AGENT_SESSION_CURRENT_REQUESTS_V2
    ? {
        records: state.asyncQuestions ?? [],
        ready: state.requestMarker.version === state.asyncQuestionAuthority?.version
      }
    : undefined
}

export function authoritativeAsyncQuestion(state: AgentSessionCurrentRequestsState) {
  return state.requestMarker?.contract === AGENT_SESSION_CURRENT_REQUESTS_V2
    ? messageQuestionPrompt(state.asyncQuestions ?? [])
    : undefined
}

export function currentAsyncQuestion(
  state: AgentSessionCurrentRequestsState,
  messages: readonly NativeChatMessage[]
) {
  return state.requestMarker?.contract === AGENT_SESSION_CURRENT_REQUESTS_V2
    ? messageQuestionPrompt(state.asyncQuestions ?? [])
    : extractPendingMessageReplyAsk(messages)
}
