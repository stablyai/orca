// CREATE-GH-STEP: the GitHub access step's per-create state, read by the build sheet's row.
import { useSyncExternalStore } from 'react'
import type {
  CloudCreateGitHubAccess,
  CloudCreateGitHubGate
} from './cloud-create-github-access-model'

export type Entry = {
  state: CloudCreateGitHubAccess
  generation: number
  neededSince: number | null
  wasNeeded: boolean
  timer: ReturnType<typeof setTimeout> | null
  waiters: ((gate: CloudCreateGitHubGate) => void)[]
}

export const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

export function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function getCloudCreateGitHubAccess(creationId: string): CloudCreateGitHubAccess | null {
  return entries.get(creationId)?.state ?? null
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCloudCreateGitHubAccess(creationId: string): CloudCreateGitHubAccess | null {
  return useSyncExternalStore(subscribe, () => getCloudCreateGitHubAccess(creationId))
}

/** Tests and fixtures: a fixed state for a creation id. */
export function setCloudCreateGitHubAccessForTest(
  creationId: string,
  state: CloudCreateGitHubAccess | null
): void {
  if (!state) {
    entries.delete(creationId)
    emit()
    return
  }
  const entry = entries.get(creationId)
  if (entry) {
    entry.state = state
  } else {
    entries.set(creationId, {
      state,
      generation: 1,
      neededSince: state.phase === 'needed' ? Date.now() : null,
      wasNeeded: state.phase === 'needed',
      timer: null,
      waiters: []
    })
  }
  emit()
}
