import { createAgentSessionCurrentRequestsReader } from './agent-session-current-requests-reader'
import {
  applyCurrentRequestsMarker,
  installCurrentRequestsCompletion,
  type AgentSessionCurrentRequestsState
} from './agent-session-current-requests'
import type {
  AgentSessionCurrentRequestsMarker,
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from './agent-session-current-requests-wire'

/** Transcript frames and complete pieces share one subscription owner on desktop and phone. */
export function createNativeChatCurrentRequestsBinding(args: {
  read: (
    request: AgentSessionCurrentRequestsRead,
    signal: AbortSignal
  ) => Promise<AgentSessionCurrentRequestsPiece>
  initialState?: AgentSessionCurrentRequestsState
  publish: (state: AgentSessionCurrentRequestsState) => void
}) {
  let state: AgentSessionCurrentRequestsState = args.initialState ?? {}
  function publish(next: AgentSessionCurrentRequestsState): void {
    if (next !== state) {
      state = next
      args.publish(state)
    }
  }
  const reader = createAgentSessionCurrentRequestsReader({
    read: args.read,
    complete: (marker, items, payload) =>
      publish(installCurrentRequestsCompletion(state, marker, items, payload)),
    replaceMarker: (marker) => publish(applyCurrentRequestsMarker(state, marker)),
    error: () => {}
  })
  return {
    invalidate: reader.invalidate,
    observe(frame: { type: string; currentRequests?: AgentSessionCurrentRequestsMarker }): void {
      if (frame.currentRequests) {
        publish(applyCurrentRequestsMarker(state, frame.currentRequests))
        reader.observe(frame.currentRequests)
      } else if (
        frame.type === 'snapshot' ||
        frame.type === 'replacement' ||
        frame.type === 'end' ||
        frame.type === 'error'
      ) {
        if (state.requestMarker) {
          if (state.requestAuthority || state.asyncQuestionAuthority) {
            publish({ ...state, requestAuthority: undefined, asyncQuestionAuthority: undefined })
          }
          reader.observe(state.requestMarker)
          reader.refresh()
        } else {
          publish({})
        }
      }
    }
  }
}
