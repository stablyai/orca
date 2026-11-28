import type { AgentStatusProjectionState } from './agent-status-projection-state'

export function notifyProjectionListeners(data: AgentStatusProjectionState): void {
  if (data.notifying) {
    return
  }
  data.notifying = true
  try {
    while (
      data.notices.size ||
      data.changedKeys.size ||
      data.fullResync ||
      data.transitionBatches.length
    ) {
      if (data.transitionBatches.length > 0) {
        const transitions = data.transitionBatches.splice(0)
        if (data.transitionListeners.size > 0) {
          for (let i = 0; i < transitions.length; i += 1) {
            const batch = transitions[i]
            for (const listener of Array.from(data.transitionListeners)) {
              if (data.transitionListeners.has(listener)) {
                try {
                  listener(batch)
                } catch (error) {
                  console.error('Agent transition observer failed', error)
                }
              }
            }
          }
        }
      }
      const hasChangeEvent = data.fullResync || data.changedKeys.size > 0
      const keys = data.fullResync
        ? null
        : hasChangeEvent && data.changeListeners.size > 0
          ? new Set(data.changedKeys)
          : undefined
      data.fullResync = false
      if (data.changedKeys.size > 0) {
        data.changedKeys.clear()
      }
      if (hasChangeEvent && data.changeListeners.size > 0) {
        for (const listener of Array.from(data.changeListeners)) {
          if (data.changeListeners.has(listener)) {
            try {
              listener(keys ?? null)
            } catch (error) {
              console.error('Agent status observer failed', error)
            }
          }
        }
      }
      if (data.notices.size > 0) {
        let listeners: Set<() => void> | undefined
        for (const channel of data.notices) {
          const channelListeners = data.listeners.get(channel)
          if (channelListeners) {
            listeners ??= new Set()
            for (const listener of channelListeners) {
              listeners.add(listener)
            }
          }
        }
        data.notices.clear()
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener()
            } catch (error) {
              console.error('Agent presentation observer failed', error)
            }
          }
        }
      }
    }
  } finally {
    data.notifying = false
  }
}
