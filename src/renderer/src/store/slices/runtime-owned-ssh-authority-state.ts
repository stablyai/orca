import type { AppState } from '../types'
import { admitRuntimeOwnedSshAuthority } from '../../../../shared/runtime-owned-ssh-authority'

export function updateRuntimeOwnedSshConnectionGeneration(
  state: AppState,
  targetId: string,
  connectionGeneration: number | null
): Partial<AppState> {
  if (
    !admitRuntimeOwnedSshAuthority({ targetId, connectionGeneration }) ||
    (state.runtimeOwnedSshConnectionGenerations.get(targetId) ?? null) === connectionGeneration
  ) {
    return state
  }
  const next = new Map(state.runtimeOwnedSshConnectionGenerations)
  if (connectionGeneration === null) {
    next.delete(targetId)
  } else {
    next.set(targetId, connectionGeneration)
  }
  return {
    runtimeOwnedSshConnectionGenerations: next,
    ...(connectionGeneration === null
      ? {}
      : { sshConnectedGeneration: state.sshConnectedGeneration + 1 })
  }
}
