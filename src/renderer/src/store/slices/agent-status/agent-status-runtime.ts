import { applyAgentStatusBatchUpdate } from './agent-status-batch-update'
import { projectAgentPaneConversation } from '../agent-pane-conversation'
import { structuralValuesEqualIgnoringUndefined } from '../../../../../shared/structural-value-equality'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  AgentStatusBatchTransaction,
  AgentStatusBatchUpdate,
  AgentStatusChange,
  AgentStatusChangeListener
} from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { GeneratedTabTitleUpdate } from '../terminal-tab-title-batch'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

export type AgentStatusStateUpdate =
  | AppState
  | Partial<AppState>
  | ((state: AppState, changedPaneKeys: Set<string>) => AppState | Partial<AppState>)

export type AgentStatusRuntime = {
  projectConversation: typeof projectAgentPaneConversation
  get: () => AppState
  subscribeAgentStatusChanges: (listener: AgentStatusChangeListener) => () => void
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
  getActions: () => Pick<
    AgentStatusSlice,
    'setAgentStatus' | 'recordAgentProviderSession' | 'setAgentProgramStatus'
  >
): AgentStatusRuntime {
  const listeners = new Set<AgentStatusChangeListener>()
  const pendingChanges: AgentStatusChange[][] = []
  let committing = 0
  let notifying = false
  let batchedPaneKeys: Set<string> | null = null
  const subscribeAgentStatusChanges = (listener: AgentStatusChangeListener): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const flushChanges = (): void => {
    if (committing || notifying) {
      return
    }
    notifying = true
    try {
      for (const accepted of pendingChanges) {
        if (!accepted?.length) {
          continue
        }
        const currentListeners = [...listeners]
        for (const listener of currentListeners) {
          if (!listeners.has(listener)) {
            continue
          }
          try {
            listener(accepted)
          } catch (error) {
            console.error('Agent status observer failed', error)
          }
        }
      }
    } finally {
      pendingChanges.length = 0
      notifying = false
    }
  }
  const commit = (
    patch: AppState | Partial<AppState>,
    before: AppState,
    paneKeys: ReadonlySet<string>
  ): void => {
    if (!listeners.size) {
      storeSet(patch, false)
      return
    }
    const changes: AgentStatusChange[] = []
    const rows = patch.agentStatusByPaneKey ?? before.agentStatusByPaneKey
    for (const paneKey of paneKeys) {
      const previous = before.agentStatusByPaneKey[paneKey]
      const current = rows[paneKey]
      if (!structuralValuesEqualIgnoringUndefined(previous, current)) {
        changes.push({ paneKey, previous, current })
      }
    }
    committing++
    pendingChanges.push(changes)
    try {
      storeSet(patch, false)
    } finally {
      // A middleware rejection before commit must never advertise accepted rows.
      if (storeGet() === before) {
        changes.length = 0
      }
      committing--
      flushChanges()
    }
  }
  let batchedAgentStatusState: AppState | null = null
  let batchedAgentStatusTouchedKeys: Set<keyof AppState> | null = null
  // Staged in-place mutations cannot signal changes by identity; count every accepted write.
  let batchedAgentStatusRevision = 0
  let batchedAgentStatusEffects: (() => void)[] | null = null
  let batchedGeneratedTabTitleUpdates: GeneratedTabTitleUpdate[] | null = null
  let batchedAgentStatusFreshnessRequested = false
  const get = (): AppState => batchedAgentStatusState ?? storeGet()

  let conversationDraft: AppState['agentConversationsByPaneKey'] | null = null
  const projectConversation: typeof projectAgentPaneConversation = (state, entry) =>
    projectAgentPaneConversation(state, entry, (entries) => {
      if (!batchedAgentStatusState) {
        return { ...entries }
      }
      const next =
        entries === conversationDraft
          ? entries
          : Object.setPrototypeOf(Object.assign(Object.create(null), entries), Object.prototype)
      conversationDraft = next
      return next
    })

  // Omit replace from this write type so no slice call can request replacement the batch cannot express.
  const set = (update: AgentStatusStateUpdate): void => {
    const staged = batchedAgentStatusState
    const before = staged ?? storeGet()
    const paneKeys = batchedPaneKeys ?? new Set<string>()
    const nextState = typeof update === 'function' ? update(before, paneKeys) : update
    if (staged === null) {
      commit(nextState, before, paneKeys)
      return
    }
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
    applyAgentStatusBatchUpdate(getActions(), update)
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
    const paneKeys = new Set<string>()
    batchedPaneKeys = paneKeys
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
      conversationDraft = null
      batchedPaneKeys = null
      batchedAgentStatusState = null
      batchedAgentStatusTouchedKeys = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
      if (hasStagedWrites) {
        commit(
          buildAgentStatusBatchPatch(initialState, nextState, touchedKeys),
          initialState,
          paneKeys
        )
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
      conversationDraft = null
      batchedPaneKeys = null
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
      // Time-based staleness changes ordering without output; bump freshness/sort epochs at boundaries.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })

  // Why: launch configs retire with the pane; a woken pane registers its config before consuming this record.
  const clearSleepingAgentSessionsByPaneKey = (paneKeys: readonly string[]): void => {
    if (paneKeys.length === 0) {
      return
    }
    const uniquePaneKeys = new Set(paneKeys)
    set((s) => {
      let nextSleeping = s.sleepingAgentSessionsByPaneKey
      for (const paneKey of uniquePaneKeys) {
        if (paneKey in nextSleeping) {
          if (nextSleeping === s.sleepingAgentSessionsByPaneKey) {
            nextSleeping = { ...nextSleeping }
          }
          delete nextSleeping[paneKey]
        }
      }
      if (nextSleeping === s.sleepingAgentSessionsByPaneKey) {
        return s
      }
      return { sleepingAgentSessionsByPaneKey: nextSleeping }
    })
  }

  return {
    projectConversation,
    subscribeAgentStatusChanges,
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
