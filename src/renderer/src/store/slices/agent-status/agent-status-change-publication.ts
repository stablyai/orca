import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { structuralValuesEqualIgnoringUndefined } from '../../../../../shared/structural-value-equality'
import type { AgentStatusChange, AgentStatusChangeListener } from './agent-status-contract'

export function createAgentStatusChangePublication(
  storeSet: Parameters<StateCreator<AppState>>[0],
  storeGet: Parameters<StateCreator<AppState>>[1]
): {
  commit: (
    patch: AppState | Partial<AppState>,
    before: AppState,
    paneKeys: ReadonlySet<string>
  ) => void
  subscribeAgentStatusChanges: (listener: AgentStatusChangeListener) => () => void
} {
  const listeners = new Set<AgentStatusChangeListener>()
  const pendingChanges: AgentStatusChange[][] = []
  let committing = 0
  let notifying = false
  const subscribeAgentStatusChanges = (listener: AgentStatusChangeListener): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const flushChanges = (): void => {
    if (committing || notifying) {
      return
    }
    notifying = true
    try {
      for (const accepted of pendingChanges) {
        if (!accepted?.length) {
          continue
        }
        const currentListeners = [...listeners]
        for (const listener of currentListeners) {
          if (!listeners.has(listener)) {
            continue
          }
          try {
            listener(accepted)
          } catch (error) {
            console.error('Agent status observer failed', error)
          }
        }
      }
    } finally {
      pendingChanges.length = 0
      notifying = false
    }
  }
  const commit = (
    patch: AppState | Partial<AppState>,
    before: AppState,
    paneKeys: ReadonlySet<string>
  ): void => {
    if (!listeners.size) {
      storeSet(patch, false)
      return
    }
    const changes: AgentStatusChange[] = []
    const rows = patch.agentStatusByPaneKey ?? before.agentStatusByPaneKey
    for (const paneKey of paneKeys) {
      const previous = before.agentStatusByPaneKey[paneKey]
      const current = rows[paneKey]
      if (!structuralValuesEqualIgnoringUndefined(previous, current)) {
        changes.push({ paneKey, previous, current })
      }
    }
    committing++
    pendingChanges.push(changes)
    try {
      storeSet(patch, false)
    } finally {
      // A middleware rejection before commit must never advertise accepted rows.
      if (storeGet() === before) {
        changes.length = 0
      }
      committing--
      flushChanges()
    }
  }
  return { commit, subscribeAgentStatusChanges }
}
