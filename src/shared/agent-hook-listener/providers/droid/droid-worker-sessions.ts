import type { HookListenerState } from '../../listener-state'

// Why: workers are tracked only inside an open root turn. Outside it a worker reports as the root,
// so a worker that outlives the root's Stop still ends the row at done with its own Stop.
export function openDroidRootTurn(state: HookListenerState, paneKey: string): void {
  state.childSessionIdsByPaneKey.set(paneKey, new Set())
}

export function isDroidWorkerSession(
  state: HookListenerState,
  paneKey: string,
  sessionId: string | undefined
): boolean {
  return (
    sessionId !== undefined && state.childSessionIdsByPaneKey.get(paneKey)?.has(sessionId) === true
  )
}

export function rememberDroidWorkerSession(
  state: HookListenerState,
  paneKey: string,
  sessionId: string
): void {
  state.childSessionIdsByPaneKey.get(paneKey)?.add(sessionId)
}

export function forgetDroidWorkerSessions(state: HookListenerState, paneKey: string): void {
  state.childSessionIdsByPaneKey.delete(paneKey)
}
