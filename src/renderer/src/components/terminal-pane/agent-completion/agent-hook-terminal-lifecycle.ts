import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

type AgentHookTerminalLifecycleHandler = (payload: AgentCompletionStatusSnapshot) => void

// Route accepted hooks by pane: global completion authority and mounted cursor/cache ownership live in different consumers.
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
