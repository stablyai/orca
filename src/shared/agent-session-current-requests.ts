import { agentSessionCurrentContextRows } from './agent-session-context-clear'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import type { AgentSessionCurrentRequestsMarker } from './agent-session-current-requests-wire'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from './agent-session-current-requests-capability'

export type AgentSessionCurrentRequestsState = {
  currentRequests?: AgentJournalRenderItem[]
  requestMarker?: AgentSessionCurrentRequestsMarker
  /** Qualification survives contact loss alongside the last complete answer. */
  requestAuthority?: AgentSessionCurrentRequestsMarker
}

export function currentRequestsState(
  state: AgentSessionCurrentRequestsState
): AgentSessionCurrentRequestsState {
  return {
    currentRequests: state.currentRequests,
    requestMarker: state.requestMarker,
    requestAuthority: state.requestAuthority
  }
}

export function applyCurrentRequestsMarker(
  state: AgentSessionCurrentRequestsState,
  marker: AgentSessionCurrentRequestsMarker
): AgentSessionCurrentRequestsState {
  if (marker.contract !== AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY) {
    return state
  }
  const prior = state.requestMarker ?? state.requestAuthority
  if (prior?.publisher === marker.publisher && marker.revision <= prior.revision) {
    return currentRequestsState(state)
  }
  const sameOwner =
    prior?.publisher === marker.publisher &&
    prior.owner === marker.owner &&
    prior.epoch === marker.epoch &&
    prior.sessionId === marker.sessionId
  return {
    currentRequests: sameOwner ? state.currentRequests : [],
    requestAuthority: sameOwner ? state.requestAuthority : undefined,
    requestMarker: marker
  }
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
    return currentRequestsState({})
  }
  const epoch = event.type === 'batch' ? event.batch.cursor.epoch : event.page.epoch
  if (
    state.requestMarker &&
    (epoch !== state.epoch || (event.fence !== undefined && event.fence !== state.fence))
  ) {
    return { currentRequests: [], requestMarker: undefined, requestAuthority: undefined }
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
