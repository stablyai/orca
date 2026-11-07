import type { StateCreator } from 'zustand'
import type { AppState } from './types'
import type { StoreSetArgs } from './react-commit-cascade-write-probe'
import {
  classifyPaneKeyLiveness,
  MAX_LIVE_AGENT_STATUSES
} from './slices/agent-status/agent-status-capacity-eviction'

type Conversations = AppState['agentConversationsByPaneKey']

function cappedConversations(state: AppState, previous: Conversations): Conversations {
  const entries = state.agentConversationsByPaneKey
  const incoming = Object.keys(entries)
  const keys = [
    ...Object.keys(previous).filter((key) => Object.hasOwn(entries, key)),
    ...incoming.filter((key) => !Object.hasOwn(previous, key))
  ]
  let evicted: string[] = []
  if (keys.length > MAX_LIVE_AGENT_STATUSES) {
    const classify = classifyPaneKeyLiveness(state)
    const eligible = keys.filter((key) => classify(key) !== 'live')
    evicted = eligible.slice(0, Math.max(0, eligible.length - MAX_LIVE_AGENT_STATUSES))
  }
  if (evicted.length === 0 && keys.every((key, index) => key === incoming[index])) {
    return entries
  }
  const removed = new Set(evicted)
  return Object.fromEntries(
    keys.filter((key) => !removed.has(key)).map((key) => [key, entries[key]])
  )
}

export function withAgentConversationRetention(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    const wrap =
      (write: typeof set): typeof set =>
      (...args: StoreSetArgs<AppState>): void => {
        if (args[1] === true) {
          const [partial] = args
          write((state) => {
            const requested = typeof partial === 'function' ? partial(state) : partial
            const entries = cappedConversations(requested, get().agentConversationsByPaneKey)
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
            const entries = cappedConversations(candidate, current.agentConversationsByPaneKey)
            return entries === candidate.agentConversationsByPaneKey
              ? requested
              : { ...requested, agentConversationsByPaneKey: entries }
          })
        }
      }
    api.setState = wrap(api.setState)
    const initial = createState(wrap(set), get, api)
    const entries = cappedConversations(initial, {})
    return entries === initial.agentConversationsByPaneKey
      ? initial
      : { ...initial, agentConversationsByPaneKey: entries }
  }
}
