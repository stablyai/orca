import { createAgentSessionCurrentRequestsReader } from './agent-session-current-requests-reader'
import {
  applyCurrentRequestsMarker,
  type AgentSessionCurrentRequestsState
} from './agent-session-current-requests'
import type {
  AgentSessionCurrentRequestsMarker,
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from './agent-session-current-requests-wire'

/** Transcript frames and complete pieces share one subscription owner on desktop and phone. */
export function createNativeChatCurrentRequestsBinding(args: {
  read: (request: AgentSessionCurrentRequestsRead) => Promise<AgentSessionCurrentRequestsPiece>
  publish: (state: AgentSessionCurrentRequestsState) => void
}) {
  let state: AgentSessionCurrentRequestsState = {}
  function publish(next: AgentSessionCurrentRequestsState): void {
    state = next
    args.publish(state)
  }
  const reader = createAgentSessionCurrentRequestsReader({
    read: args.read,
    complete: (marker, items, payload) =>
      publish({
        currentRequests: items,
        asyncQuestions: payload?.asyncQuestions,
        requestContext: payload?.context,
        requestMarker: marker,
        requestAuthority: marker
      }),
    replaceMarker: (marker) => publish(applyCurrentRequestsMarker(state, marker)),
    error: () => {}
  })
  return {
    invalidate: reader.invalidate,
    observe(frame: { type: string; currentRequests?: AgentSessionCurrentRequestsMarker }): void {
      if (frame.type === 'snapshot' || frame.type === 'replacement') {
        reader.invalidate()
      }
      if (frame.currentRequests) {
        publish(applyCurrentRequestsMarker(state, frame.currentRequests))
        reader.observe(frame.currentRequests)
      } else if (frame.type === 'snapshot') {
        publish({})
      }
    }
  }
}
