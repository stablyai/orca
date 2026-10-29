import { structuralValuesEqualIgnoringUndefined } from '../../../../../shared/structural-value-equality'
import type { SessionStateCreator } from '@/store/session-source-write-boundary'
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
import {
  editSessionSource,
  unwrapSessionSourceWrite,
  composeSessionSourceWrites,
  type SessionSourcePartial
} from '../../session-source-edits'

export type AgentStatusStateUpdate =
  | SessionSourcePartial<AppState>
  | ((state: AppState, changedPaneKeys: Set<string>) => SessionSourcePartial<AppState> | undefined)

export type AgentStatusRuntime = {
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
  storeSet: Parameters<SessionStateCreator<AppState>>[0],
  storeGet: Parameters<SessionStateCreator<AppState>>[1],
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
    patch: SessionSourcePartial<AppState>,
    before: AppState,
    paneKeys: ReadonlySet<string>
  ): void => {
    if (!listeners.size) {
      storeSet(patch, false)
      return
    }
    const changes: AgentStatusChange[] = []
    const rows =
      unwrapSessionSourceWrite(patch).partial.agentStatusByPaneKey ?? before.agentStatusByPaneKey
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
  let batchedSourceWrites: SessionSourcePartial<AppState>[] | null = null
  // Staged in-place mutations cannot signal changes by identity; count every accepted write.
  let batchedAgentStatusRevision = 0
  let batchedAgentStatusEffects: (() => void)[] | null = null
  let batchedGeneratedTabTitleUpdates: GeneratedTabTitleUpdate[] | null = null
  let batchedAgentStatusFreshnessRequested = false
  const get = (): AppState => batchedAgentStatusState ?? storeGet()

  // Omit replace from this write type so no slice call can request replacement the batch cannot express.
  const set = (update: AgentStatusStateUpdate): void => {
    const staged = batchedAgentStatusState
    const before = staged ?? storeGet()
    const paneKeys = batchedPaneKeys ?? new Set<string>()
    const nextState = typeof update === 'function' ? update(before, paneKeys) : update
    if (nextState === undefined) {
      return
    }
    if (staged === null) {
      commit(nextState, before, paneKeys)
      return
    }
    batchedAgentStatusRevision += 1
    const { partial } = unwrapSessionSourceWrite(nextState)
    batchedSourceWrites?.push(nextState)
    // The staged root is private until commit; prior published values remain immutable.
    Object.assign(staged, partial)
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
    } else if (update.kind === 'programStatus') {
      actions.setAgentProgramStatus(update.paneKey, update.programStatus)
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
    const paneKeys = new Set<string>()
    batchedPaneKeys = paneKeys
    const revisionAtStart = batchedAgentStatusRevision
    batchedAgentStatusState = { ...initialState }
    batchedSourceWrites = []
    batchedAgentStatusEffects = []
    batchedGeneratedTabTitleUpdates = []
    try {
      const result = operation(batchTransaction)
      const nextState = batchedAgentStatusState
      const effects = batchedAgentStatusEffects
      const generatedTabTitleUpdates = batchedGeneratedTabTitleUpdates
      const freshnessRequested = batchedAgentStatusFreshnessRequested
      const hasStagedWrites = batchedAgentStatusRevision !== revisionAtStart
      const sourceWrites = batchedSourceWrites
      batchedPaneKeys = null
      batchedAgentStatusState = null
      batchedSourceWrites = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
      if (hasStagedWrites) {
        const patch = composeSessionSourceWrites(sourceWrites, true, {
          before: initialState,
          after: nextState
        })
        commit(patch, initialState, paneKeys)
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
      batchedPaneKeys = null
      batchedAgentStatusState = null
      batchedSourceWrites = null
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
      const edit = editSessionSource(s)
      let changed = false
      for (const paneKey of uniquePaneKeys) {
        if (paneKey in s.sleepingAgentSessionsByPaneKey) {
          edit.remove('sleepingAgentSessionsByPaneKey', paneKey)
          changed = true
        }
      }
      if (!changed) {
        return undefined
      }
      return edit.finish()
    })
  }

  return {
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
