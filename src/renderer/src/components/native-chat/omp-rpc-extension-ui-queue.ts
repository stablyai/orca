// The RPC pane's extension-UI request queue: which `extension_ui_request`
// frames become an inline card, which are log-and-ignore, and how a second
// request waits behind the one already showing.
//
// Generic over the surrounding state so this owns the two queue fields without
// importing the turn state that embeds them.

import type { OmpRpcExtensionUiRequestFrame } from '../../../../shared/omp-rpc-protocol'

/** Extension-UI methods rendered as an inline card (D7). Every other method
 *  (notify/setStatus/setWidget/setTitle/set_editor_text/open_url/...) is
 *  logged-and-ignored per this milestone's minimal scope. */
const CARD_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

export type OmpRpcExtensionUiQueue = {
  pendingExtensionUiRequest: OmpRpcExtensionUiRequestFrame | null
  queuedExtensionUiRequests: OmpRpcExtensionUiRequestFrame[]
}

function withoutRequest(
  requests: OmpRpcExtensionUiRequestFrame[],
  id: string
): OmpRpcExtensionUiRequestFrame[] {
  return requests.filter((request) => request.id !== id)
}

function isActionableExtensionUiRequest(request: OmpRpcExtensionUiRequestFrame): boolean {
  // Why (F6): a `select` whose `options` are absent/empty is a valid frame
  // shape the validator accepts, but it renders zero buttons — promoting it
  // would wedge the pane (the composer is unmounted for a pending request)
  // with no way out. Fall through to log-and-ignore instead.
  if (request.method === 'select') {
    return (request.options ?? []).length > 0
  }
  return true
}

/** Retires one request, promoting the next queued one into its place. */
export function dismissExtensionUiRequest<T extends OmpRpcExtensionUiQueue>(
  state: T,
  id: string
): T {
  if (state.pendingExtensionUiRequest?.id === id) {
    const [next, ...rest] = state.queuedExtensionUiRequests
    return { ...state, pendingExtensionUiRequest: next ?? null, queuedExtensionUiRequests: rest }
  }
  return {
    ...state,
    queuedExtensionUiRequests: withoutRequest(state.queuedExtensionUiRequests, id)
  }
}

export function reduceExtensionUiRequest<T extends OmpRpcExtensionUiQueue>(
  state: T,
  request: OmpRpcExtensionUiRequestFrame
): T {
  if (request.method === 'cancel') {
    return dismissExtensionUiRequest(state, request.id)
  }
  if (!CARD_METHODS.has(request.method) || !isActionableExtensionUiRequest(request)) {
    // Why: notify/setStatus/setWidget/setTitle/... are log-and-ignore this
    // milestone (scope item 7) — the caller is expected to log, not the reducer.
    return state
  }
  if (!state.pendingExtensionUiRequest) {
    return { ...state, pendingExtensionUiRequest: request }
  }
  if (state.pendingExtensionUiRequest.id === request.id) {
    return state
  }
  return {
    ...state,
    queuedExtensionUiRequests: [
      ...withoutRequest(state.queuedExtensionUiRequests, request.id),
      request
    ]
  }
}
