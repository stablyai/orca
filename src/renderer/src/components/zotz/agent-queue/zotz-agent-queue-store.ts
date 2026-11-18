import { useSyncExternalStore } from 'react'
import {
  EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT,
  type ZotzAgentQueueSnapshot
} from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'

let snapshot: ZotzAgentQueueSnapshot = EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT
const listeners = new Set<() => void>()
let stopListening: (() => void) | null = null

// An older main (or remote host) omits fields added since; fill them so panes never crash on them.
function publish(next: Partial<ZotzAgentQueueSnapshot>): void {
  snapshot = { ...EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT, ...next, canceled: next.canceled ?? [] }
  for (const listener of listeners) {
    listener()
  }
}

// Main pushes every change; the first subscriber also asks once so a fresh window is not blank.
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!stopListening && window.api?.zotzAgentQueue) {
    stopListening = window.api.zotzAgentQueue.onChanged(publish)
    void window.api.zotzAgentQueue.snapshot().then(publish, () => {})
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopListening?.()
      stopListening = null
    }
  }
}

export function useZotzAgentQueue(): ZotzAgentQueueSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}
