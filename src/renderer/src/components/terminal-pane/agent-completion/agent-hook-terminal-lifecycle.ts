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

/** False when no mounted pane owns `paneKey`, so the caller applies the pane effects itself. */
export function dispatchAgentHookTerminalLifecycle(
  paneKey: string,
  payload: AgentCompletionStatusSnapshot
): boolean {
  const handler = handlersByPaneKey.get(paneKey)
  handler?.(payload)
  return handler !== undefined
}
