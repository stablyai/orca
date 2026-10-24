import { applyAgentStatusPatch, type AgentStatusPatch } from '../../../agent-status-patch'
import type { AgentStatusReadState } from '../../../agent-status-observers'
import type { StoreApi } from 'zustand'
import type { AppState } from '../../../types'
import { findAgentStatusOwner } from '../../../agent-status-commit'

export type PreparedPurgeOwnership = { install: () => void; effects: (() => void)[] }

export function preparePurgeOwnership(
  state: Parameters<typeof findAgentStatusOwner>[0],
  prepared: PreparedPurgeOwnership
): void {
  const owner = findAgentStatusOwner(state)
  if (owner) {
    owner.preparePurgeOwnership(prepared)
  } else {
    prepared.install()
    for (const effect of prepared.effects) {
      effect()
    }
  }
}

export function afterPurgeAcceptance(
  state: Parameters<typeof findAgentStatusOwner>[0],
  effect: () => void
): void {
  const owner = findAgentStatusOwner(state)
  if (owner) {
    owner.afterCommit(effect)
  } else {
    effect()
  }
}

export function coordinatedPurgeSet(set: StoreApi<AppState>['setState'], get: () => AppState) {
  return (update: AgentStatusPatch | ((state: AgentStatusReadState) => AgentStatusPatch)): void =>
    applyAgentStatusPatch({ getState: get, setState: set }, update)
}
