import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { StoreSetArgs } from '../../diagnostics/react-commit-cascade-write-probe'
import { createAgentConversationCapacityIndex } from './agent-conversation-capacity-index'

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
    const wrap =
      (write: typeof set): typeof set =>
      (...args: StoreSetArgs<AppState>): void => {
        if (args[1] === true) {
          const [partial] = args
          write((state) => {
            const requested = typeof partial === 'function' ? partial(state) : partial
            const entries = cap(requested, state)
            return entries === requested.agentConversationsByPaneKey
              ? requested
              : { ...requested, agentConversationsByPaneKey: entries }
          }, true)
        } else {
          const [partial] = args
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
    api.setState = wrap(api.setState)
    const initial = createState(wrap(set), get, api)
    const entries = index.cap(initial.agentConversationsByPaneKey, initial.terminalLayoutsByTabId)
    return entries === initial.agentConversationsByPaneKey
      ? initial
      : { ...initial, agentConversationsByPaneKey: entries }
  }
}
