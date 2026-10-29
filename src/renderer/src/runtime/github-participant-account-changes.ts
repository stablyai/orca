import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { getRuntimeTargetHostId } from './runtime-client-target'
import { invalidateGitHubParticipantReads } from './github-participant-read-fencing'

const listeners = new Map<string, Set<() => void>>()

export function subscribeGitHubParticipantAccountsChanged(
  target: RuntimeClientTarget,
  listener: () => void
): () => void {
  const hostId = getRuntimeTargetHostId(target)
  let subscriptions = listeners.get(hostId)
  if (!subscriptions) {
    subscriptions = new Set()
    listeners.set(hostId, subscriptions)
  }
  subscriptions.add(listener)
  return () => {
    subscriptions.delete(listener)
    if (!subscriptions.size) {
      listeners.delete(hostId)
    }
  }
}

export function applyGitHubParticipantAccountsChanged(target: RuntimeClientTarget): void {
  invalidateGitHubParticipantReads(target)
  const hostId = getRuntimeTargetHostId(target)
  const state = useAppStore.getState()
  for (const repo of state.repos ?? []) {
    if (getRepoExecutionHostId(repo) === hostId) {
      state.evictGitHubRepoCaches(repo.id, repo.path, hostId)
    }
  }
  for (const listener of listeners.get(hostId) ?? []) {
    listener()
  }
}
