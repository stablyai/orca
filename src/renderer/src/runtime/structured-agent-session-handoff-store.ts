import { useSyncExternalStore } from 'react'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'

export type TerminalStructuredHandoff = {
  sessionId: string
  fence: number
  status: AgentSessionHandoffStatus
}

const byTerminalTabId = new Map<string, TerminalStructuredHandoff>()
const listeners = new Set<() => void>()

export function publishStructuredHandoff(input: TerminalStructuredHandoff): void {
  for (const [tabId, current] of byTerminalTabId) {
    if (current.sessionId === input.sessionId && tabId !== input.status.terminal?.tabId) {
      byTerminalTabId.delete(tabId)
    }
  }
  if (input.status.terminal) {
    byTerminalTabId.set(input.status.terminal.tabId, input)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function clearStructuredHandoff(sessionId: string): void {
  let changed = false
  for (const [tabId, current] of byTerminalTabId) {
    if (current.sessionId === sessionId) {
      byTerminalTabId.delete(tabId)
      changed = true
    }
  }
  if (changed) {
    for (const listener of listeners) {
      listener()
    }
  }
}

export function useTerminalStructuredHandoff(tabId: string): TerminalStructuredHandoff | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => byTerminalTabId.get(tabId) ?? null
  )
}
