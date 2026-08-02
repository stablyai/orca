import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

type AgentHookTerminalLifecycleHandler = (payload: AgentCompletionStatusSnapshot) => void

// Why: hook completion authority may live in the global IPC coordinator while
// cursor/cache effects belong to the mounted pane; route accepted events by pane.
const handlersByPaneKey = new Map<string, AgentHookTerminalLifecycleHandler>()

export function registerAgentHookTerminalLifecycleHandler(
  paneKey: string,
  handler: AgentHookTerminalLifecycleHandler
): () => void {
  handlersByPaneKey.set(paneKey, handler)
  return () => {
    if (handlersByPaneKey.get(paneKey) === handler) {
      handlersByPaneKey.delete(paneKey)
    }
  }
}

export function dispatchAgentHookTerminalLifecycle(
  paneKey: string,
  payload: AgentCompletionStatusSnapshot
): void {
  handlersByPaneKey.get(paneKey)?.(payload)
}
