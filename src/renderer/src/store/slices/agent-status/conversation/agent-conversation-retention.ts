import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import { createAgentConversationCapacityIndex } from './agent-conversation-capacity-index'

type StorePartial =
  | AppState
  | Partial<AppState>
  | ((state: AppState) => AppState | Partial<AppState>)

export function withAgentConversationRetention(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    let index = createAgentConversationCapacityIndex()
    const cap = (
      candidate: AppState,
      current: AppState
    ): AppState['agentConversationsByPaneKey'] => {
      try {
        if (!index.matches(current)) {
          index = createAgentConversationCapacityIndex()
          index.cap(current.agentConversationsByPaneKey, current.terminalLayoutsByTabId)
        }
        return index.cap(candidate.agentConversationsByPaneKey, candidate.terminalLayoutsByTabId)
      } catch (error) {
        index = createAgentConversationCapacityIndex()
        throw error
      }
    }
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (partial: StorePartial, replace?: boolean): void => {
        if (replace === true) {
          if (typeof partial !== 'function') {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replace=true overload passes a complete AppState.
            const fullPartial = partial as AppState
            const current = get()
            if (
              fullPartial.agentConversationsByPaneKey === current.agentConversationsByPaneKey &&
              fullPartial.terminalLayoutsByTabId === current.terminalLayoutsByTabId &&
              index.matches(current)
            ) {
              write(fullPartial, true)
              return
            }
          }
          write((state) => {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replace=true overload requires a complete AppState.
            const requested = (typeof partial === 'function' ? partial(state) : partial) as AppState
            if (
              requested.agentConversationsByPaneKey === state.agentConversationsByPaneKey &&
              requested.terminalLayoutsByTabId === state.terminalLayoutsByTabId &&
              index.matches(state)
            ) {
              return requested
            }
            const entries = cap(requested, state)
            return entries === requested.agentConversationsByPaneKey
              ? requested
              : { ...requested, agentConversationsByPaneKey: entries }
          }, true)
        } else {
          if (
            typeof partial !== 'function' &&
            !Object.hasOwn(partial, 'agentConversationsByPaneKey') &&
            !Object.hasOwn(partial, 'terminalLayoutsByTabId')
          ) {
            write(partial, false)
            return
          }
          write((state) => {
            const requested = typeof partial === 'function' ? partial(state) : partial
            if (
              requested === state ||
              (!Object.hasOwn(requested, 'agentConversationsByPaneKey') &&
                !Object.hasOwn(requested, 'terminalLayoutsByTabId'))
            ) {
              return requested
            }
            const current = get()
            const candidate = { ...current, ...requested }
            const entries = cap(candidate, current)
            return entries === candidate.agentConversationsByPaneKey
              ? requested
              : { ...requested, agentConversationsByPaneKey: entries }
          })
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: named parameters implement both Zustand setState overloads without rest-args allocation.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    const initial = createState(wrap(set), get, api)
    const entries = index.cap(initial.agentConversationsByPaneKey, initial.terminalLayoutsByTabId)
    return entries === initial.agentConversationsByPaneKey
      ? initial
      : { ...initial, agentConversationsByPaneKey: entries }
  }
}
