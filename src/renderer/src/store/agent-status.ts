import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useStore, type StoreApi } from 'zustand'
import type { AppState } from './types'
import { useAppStore } from './index'
import { getAgentStatusOwner } from './agent-status-commit'
import type { AgentStatusReadState, AgentStatusSnapshot } from './agent-status-observers'
import type { AgentStatusEntry } from './slices/agent-status-contract'

export function getAgentStatusEntry(paneKey: string): AgentStatusEntry | undefined {
  return getAgentStatusOwner(useAppStore).getEntry(paneKey)
}

export function getAgentStatusState(): AgentStatusReadState {
  return getAgentStatusOwner(useAppStore).getState()
}

export function subscribeAgentStatusState(
  listener: (state: AgentStatusReadState, previous: AgentStatusReadState) => void,
  store: Pick<StoreApi<AppState>, 'getState' | 'subscribe'> = useAppStore,
  paneKey?: string
): () => void {
  const owner = getAgentStatusOwner(store)
  let previous = owner.getState()
  const notify = (): void => {
    const next = owner.getState()
    if (next === previous) {
      return
    }
    const before = previous
    previous = next
    listener(next, before)
  }
  const app = store.subscribe(notify)
  const status = paneKey ? owner.subscribeEntry(paneKey, notify) : owner.subscribeAggregate(notify)
  return () => {
    app()
    status()
  }
}

export function useAgentStatusField<Result>(
  paneKey: string | null | undefined,
  selector: (entry: AgentStatusEntry | undefined) => Result
): Result {
  const owner = getAgentStatusOwner(useAppStore)
  const inputs = useMemo(
    () => ({
      getState: () => (paneKey ? owner.getEntry(paneKey) : undefined),
      getInitialState: () => (paneKey ? owner.getEntry(paneKey) : undefined),
      subscribe(
        listener: (
          entry: AgentStatusEntry | undefined,
          previous: AgentStatusEntry | undefined
        ) => void
      ) {
        if (!paneKey) {
          return () => {}
        }
        let previous = owner.getEntry(paneKey)
        return owner.subscribeEntry(paneKey, () => {
          const next = owner.getEntry(paneKey)
          const before = previous
          previous = next
          listener(next, before)
        })
      }
    }),
    [owner, paneKey]
  )
  return useStore(inputs, selector)
}
export function useAgentStatusEntry(
  paneKey: string | null | undefined
): AgentStatusEntry | undefined {
  return useAgentStatusField(paneKey, (entry) => entry)
}

const EMPTY_STATUS: AgentStatusSnapshot = {}
export function useAgentStatusSnapshot(enabled = true): AgentStatusSnapshot {
  const owner = getAgentStatusOwner(useAppStore)
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? owner.subscribeAggregate(listener) : () => {}),
    [owner, enabled]
  )
  const read = useCallback(() => (enabled ? owner.getSnapshot() : EMPTY_STATUS), [owner, enabled])
  return useSyncExternalStore(subscribe, read, read)
}

/** Joined selectors use explicit keys when their live input is a known pane collection. */
export function useAgentStatusSelector<Result>(
  selector: (state: AgentStatusReadState) => Result,
  paneKeys?: readonly string[],
  tabId?: string
): Result {
  const owner = getAgentStatusOwner(useAppStore)
  const inputs = useMemo(
    () => ({
      getState: owner.getState,
      getInitialState: owner.getState,
      subscribe(listener: (state: AgentStatusReadState, previous: AgentStatusReadState) => void) {
        let previous = owner.getState()
        const notify = (): void => {
          const next = owner.getState()
          if (next !== previous) {
            const before = previous
            previous = next
            listener(next, before)
          }
        }
        const app = useAppStore.subscribe(notify)
        const statuses = tabId
          ? [owner.subscribeTab(tabId, notify)]
          : paneKeys
            ? paneKeys.map((key) => owner.subscribeEntry(key, notify))
            : [owner.subscribeAggregate(notify)]
        return () => {
          app()
          for (const unsubscribe of statuses) {
            unsubscribe()
          }
        }
      }
    }),
    [owner, paneKeys, tabId]
  )
  return useStore(inputs, selector)
}
