import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AgentStatusBatchTransaction, AgentStatusBatchUpdate } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

export type AgentStatusStateUpdate =
  | AppState
  | Partial<AppState>
  | ((state: AppState) => AppState | Partial<AppState>)

export type AgentStatusRuntime = {
  get: () => AppState
  set: (update: AgentStatusStateUpdate) => void
  runAfterCommit: (effect: () => void) => void
  applyGeneratedTabTitleUpdate: (update: GeneratedTabTitleUpdate) => void
  requestFreshness: (acceptedInBatch: boolean) => void
  freshness: ReturnType<typeof createFreshnessScheduler>
  transactAgentStatuses: <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ) => Result
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
}

export function createAgentStatusRuntime(
  storeSet: Parameters<StateCreator<AppState>>[0],
  storeGet: Parameters<StateCreator<AppState>>[1],
  getActions: () => Pick<AgentStatusSlice, 'setAgentStatus' | 'recordAgentProviderSession'>
): AgentStatusRuntime {
  let batchedAgentStatusState: AppState | null = null
  let batchedAgentStatusTouchedKeys: Set<keyof AppState> | null = null
  // Identity can no longer report "this staged update changed something" once the staged object is
  // mutated in place, so every accepted staged write advances this instead.
  let batchedAgentStatusRevision = 0
  let batchedAgentStatusEffects: (() => void)[] | null = null
  let batchedGeneratedTabTitleUpdates: GeneratedTabTitleUpdate[] | null = null
  let batchedAgentStatusFreshnessRequested = false
  const get = (): AppState => batchedAgentStatusState ?? storeGet()

  // Deliberately narrower than zustand's `set`: no `replace` parameter, so no call site in
  // this slice can compile into a REPLACE the batch commit is unable to express.
  const set = (update: AgentStatusStateUpdate): void => {
    const staged = batchedAgentStatusState
    if (staged === null) {
      storeSet(update, false)
      return
    }
    const nextState = typeof update === 'function' ? update(staged) : update
    if (Object.is(nextState, staged)) {
      return
    }
    batchedAgentStatusRevision += 1
    const touched = batchedAgentStatusTouchedKeys
    if (touched) {
      for (const key of Object.keys(nextState)) {
        touched.add(key as keyof AppState)
      }
    }
    // The staged object is private until commit, so fold into it instead of cloning AppState per update.
    Object.assign(staged, nextState)
  }

  const runAfterCommit = (effect: () => void): void => {
    if (batchedAgentStatusEffects) {
      batchedAgentStatusEffects.push(effect)
      return
    }
    effect()
  }

  const applyGeneratedTabTitleUpdate = (update: GeneratedTabTitleUpdate): void => {
    if (batchedGeneratedTabTitleUpdates) {
      batchedGeneratedTabTitleUpdates.push(update)
      return
    }
    if (update.options) {
      get().setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt, update.options)
    } else {
      get().setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt)
    }
  }

  const requestFreshness = (acceptedInBatch: boolean): void => {
    if (batchedAgentStatusState !== null) {
      batchedAgentStatusFreshnessRequested ||= acceptedInBatch
      return
    }
    freshness.scheduleDeferred()
  }

  const applyBatchedAgentStatusUpdate = (update: AgentStatusBatchUpdate): boolean => {
    if (!batchedAgentStatusState) {
      return false
    }
    const revisionBeforeUpdate = batchedAgentStatusRevision
    const actions = getActions()
    if (update.kind === 'providerSession') {
      actions.recordAgentProviderSession(
        update.paneKey,
        update.agent,
        update.providerSession,
        update.timing,
        update.routing,
        update.metadata
      )
    } else {
      actions.setAgentStatus(
        update.paneKey,
        update.payload,
        update.terminalTitle,
        update.timing,
        update.routing,
        update.metadata
      )
    }
    return batchedAgentStatusRevision !== revisionBeforeUpdate
  }

  const batchTransaction: AgentStatusBatchTransaction = {
    getState: get,
    apply: applyBatchedAgentStatusUpdate,
    afterCommit: runAfterCommit
  }

  const transactAgentStatuses = <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ): Result => {
    if (batchedAgentStatusState) {
      return operation(batchTransaction)
    }
    const initialState = storeGet()
    const touchedKeys = new Set<keyof AppState>()
    const revisionAtStart = batchedAgentStatusRevision
    batchedAgentStatusState = { ...initialState }
    batchedAgentStatusTouchedKeys = touchedKeys
    batchedAgentStatusEffects = []
    batchedGeneratedTabTitleUpdates = []
    try {
      const result = operation(batchTransaction)
      const nextState = batchedAgentStatusState
      const effects = batchedAgentStatusEffects
      const generatedTabTitleUpdates = batchedGeneratedTabTitleUpdates
      const freshnessRequested = batchedAgentStatusFreshnessRequested
      const hasStagedWrites = batchedAgentStatusRevision !== revisionAtStart
      batchedAgentStatusState = null
      batchedAgentStatusTouchedKeys = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
      if (hasStagedWrites) {
        storeSet(buildAgentStatusBatchPatch(initialState, nextState, touchedKeys), false)
      }
      if (generatedTabTitleUpdates.length > 0) {
        storeGet().setGeneratedTabTitlesFromAgentPrompts(generatedTabTitleUpdates)
      }
      if (freshnessRequested) {
        freshness.scheduleDeferred()
      }
      for (const effect of effects) {
        effect()
      }
      return result
    } finally {
      batchedAgentStatusState = null
      batchedAgentStatusTouchedKeys = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
    }
  }

  const freshness = createFreshnessScheduler({
    getStatusEntries: () => get().agentStatusByPaneKey,
    bumpEpochs: () => {
      // Why: freshness is time-based — bump both epochs at the stale boundary to force selector
      // recompute and re-sort even with no new output, since staleness can change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })

  const clearSleepingAgentSessionsByPaneKey = (paneKeys: readonly string[]): void => {
    if (paneKeys.length === 0) {
      return
    }
    const uniquePaneKeys = new Set(paneKeys)
    set((s) => {
      let nextSleeping = s.sleepingAgentSessionsByPaneKey
      let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
      for (const paneKey of uniquePaneKeys) {
        if (paneKey in nextSleeping) {
          if (nextSleeping === s.sleepingAgentSessionsByPaneKey) {
            nextSleeping = { ...nextSleeping }
          }
          delete nextSleeping[paneKey]
        }
        if (paneKey in nextLaunchConfigs) {
          if (nextLaunchConfigs === s.agentLaunchConfigByPaneKey) {
            nextLaunchConfigs = { ...nextLaunchConfigs }
          }
          delete nextLaunchConfigs[paneKey]
        }
      }
      if (
        nextSleeping === s.sleepingAgentSessionsByPaneKey &&
        nextLaunchConfigs === s.agentLaunchConfigByPaneKey
      ) {
        return s
      }
      return {
        sleepingAgentSessionsByPaneKey: nextSleeping,
        agentLaunchConfigByPaneKey: nextLaunchConfigs
      }
    })
  }

  return {
    get,
    set,
    runAfterCommit,
    applyGeneratedTabTitleUpdate,
    requestFreshness,
    freshness,
    transactAgentStatuses,
    clearSleepingAgentSessionsByPaneKey
  }
}

function buildAgentStatusBatchPatch(
  initialState: AppState,
  nextState: AppState,
  touchedKeys: ReadonlySet<keyof AppState>
): Partial<AppState> {
  const patch: Record<string, unknown> = {}
  // Untouched slices cannot differ, so the patch stays proportional to what the fold actually wrote.
  for (const key of touchedKeys) {
    if (!Object.is(nextState[key], initialState[key])) {
      patch[key as string] = nextState[key]
    }
  }
  return patch as Partial<AppState>
}
