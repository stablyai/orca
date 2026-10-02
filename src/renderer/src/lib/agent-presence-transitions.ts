import type { AgentProcessPresence } from '../../../shared/agent-process-presence'

type PresenceListener = (presence: AgentProcessPresence | undefined) => void

const listenersByPaneKey = new Map<string, Set<PresenceListener>>()

/** Per-pane owner updates without a raw store subscriber per mounted pane. */
export function observeAgentPresence(paneKey: string, listener: PresenceListener): () => void {
  const listeners = listenersByPaneKey.get(paneKey) ?? new Set<PresenceListener>()
  listeners.add(listener)
  listenersByPaneKey.set(paneKey, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByPaneKey.get(paneKey) === listeners) {
      listenersByPaneKey.delete(paneKey)
    }
  }
}

export function publishAgentPresence(
  paneKey: string,
  presence: AgentProcessPresence | undefined
): void {
  for (const listener of Array.from(listenersByPaneKey.get(paneKey) ?? [])) {
    listener(presence)
  }
}
