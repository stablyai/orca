import type { StoreApi } from 'zustand'
import type { AppState } from './types'
import type { AgentStatusReadState } from './agent-status-observers'
import { getAgentStatusOwner } from './agent-status-commit'

export type AgentStatusPatch = Partial<AgentStatusReadState> | AgentStatusReadState
export function applyAgentStatusPatch(
  store: Pick<StoreApi<AppState>, 'getState' | 'setState'>,
  update: AgentStatusPatch | ((state: AgentStatusReadState) => AgentStatusPatch)
): void {
  getAgentStatusOwner(store).transact((transaction) => {
    const state = transaction.getState()
    const patch = typeof update === 'function' ? update(state) : update
    if (patch === state) {
      return
    }
    const { agentStatusByPaneKey, ...app } = patch
    if (agentStatusByPaneKey && agentStatusByPaneKey !== state.agentStatusByPaneKey) {
      for (const key of new Set([
        ...Object.keys(state.agentStatusByPaneKey),
        ...Object.keys(agentStatusByPaneKey)
      ])) {
        transaction.setEntry(key, agentStatusByPaneKey[key])
      }
    }
    if (
      Object.entries(app).some(
        ([key, value]) => Object.getOwnPropertyDescriptor(state, key)?.value !== value
      )
    ) {
      store.setState(app)
    }
  })
}
