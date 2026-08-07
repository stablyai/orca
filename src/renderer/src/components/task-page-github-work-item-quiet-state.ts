import { taskPageGitHubFamilyDirtyKey } from './task-page-github-work-item-mutation-keys'

export type QuietRevalidateState = {
  inFlight: boolean
  trailingQueued: boolean
  dirtyGeneration: number
  fetchStartedAtGeneration: number
  familyDirtyAt: Map<string, number>
  lagSkipAttempts: Map<string, number>
  networkFailureAttempts: number
  lastConfirmAt: number
  runGeneration: number
  runOwner: object | null
}

const quietByQueryKey = new Map<string, QuietRevalidateState>()

export function getOrCreateQuietRevalidateState(queryKey: string): QuietRevalidateState {
  let state = quietByQueryKey.get(queryKey)
  if (!state) {
    state = {
      inFlight: false,
      trailingQueued: false,
      dirtyGeneration: 0,
      fetchStartedAtGeneration: 0,
      familyDirtyAt: new Map(),
      lagSkipAttempts: new Map(),
      networkFailureAttempts: 0,
      lastConfirmAt: 0,
      runGeneration: 0,
      runOwner: null
    }
    quietByQueryKey.set(queryKey, state)
  }
  return state
}

export function beginTaskPageQuietRevalidateRun(
  state: QuietRevalidateState,
  owner: object
): number | null {
  if (state.inFlight && state.runOwner === owner) {
    state.trailingQueued = true
    return null
  }
  state.inFlight = true
  state.trailingQueued = false
  state.runGeneration += 1
  state.runOwner = owner
  return state.runGeneration
}

export function finishTaskPageQuietRevalidateRun(
  state: QuietRevalidateState,
  owner: object,
  generation: number
): boolean {
  if (state.runOwner !== owner || state.runGeneration !== generation) {
    return false
  }
  state.inFlight = false
  state.runOwner = null
  return true
}

export function getQuietRevalidateState(queryKey: string): QuietRevalidateState | undefined {
  return quietByQueryKey.get(queryKey)
}

export function markTaskPageGitHubFamiliesDirty(
  queryKey: string,
  itemKey: string,
  families: readonly string[]
): void {
  const quiet = getOrCreateQuietRevalidateState(queryKey)
  quiet.dirtyGeneration += 1
  quiet.lastConfirmAt = Date.now()
  quiet.networkFailureAttempts = 0
  for (const family of families) {
    const familyKey = taskPageGitHubFamilyDirtyKey(itemKey, family)
    quiet.familyDirtyAt.set(familyKey, quiet.dirtyGeneration)
    quiet.lagSkipAttempts.delete(familyKey)
  }
}

export function clearTaskPageGitHubQuietStates(): void {
  quietByQueryKey.clear()
}
