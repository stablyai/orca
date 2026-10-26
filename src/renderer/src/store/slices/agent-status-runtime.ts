import type { createAgentPaneAuthority } from './agent-pane-authority'
import type { AgentStatusObservationSequencer } from '../../../../shared/agent-status-observation'
import { applyAgentStatusPatch } from '../agent-status-patch'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { getAgentStatusOwner, type AgentStatusTransaction } from '../agent-status-commit'
import type { AgentStatusReadState } from '../agent-status-observers'
import type { AgentStatusBatchTransaction, AgentStatusBatchUpdate } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { GeneratedTabTitleUpdate } from './terminal-tab-title-batch'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

export type AgentStatusStateUpdate =
  | AgentStatusReadState
  | Partial<AgentStatusReadState>
  | ((state: AgentStatusReadState) => AgentStatusReadState | Partial<AgentStatusReadState>)

export type AgentStatusRuntime = {
  authority: () => ReturnType<typeof createAgentPaneAuthority>
  observations: () => AgentStatusObservationSequencer
  get: () => AgentStatusReadState
  setEntry: AgentStatusTransaction['setEntry']
  editEntries: AgentStatusTransaction['editEntries']
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
  const owner = getAgentStatusOwner({ getState: storeGet })
  const get = owner.getTransactionState
  const set = (update: AgentStatusStateUpdate): void =>
    applyAgentStatusPatch({ getState: storeGet, setState: storeSet }, update)
  const runAfterCommit = owner.afterCommit
  const editEntries: AgentStatusTransaction['editEntries'] = (edit) =>
    owner.transact((transaction) => transaction.editEntries(edit))
  const setEntry: AgentStatusTransaction['setEntry'] = (key, entry) =>
    owner.transact((transaction) => transaction.setEntry(key, entry))
  let generatedTitles: GeneratedTabTitleUpdate[] | null = null
  let freshnessRequested = false
  const applyGeneratedTabTitleUpdate = (update: GeneratedTabTitleUpdate): void => {
    if (generatedTitles) {
      generatedTitles.push(update)
    } else {
      runAfterCommit(() => storeGet().setGeneratedTabTitlesFromAgentPrompts([update]))
    }
  }
  const requestFreshness = (acceptedInBatch: boolean): void => {
    if (generatedTitles) {
      freshnessRequested ||= acceptedInBatch
    } else {
      runAfterCommit(freshness.scheduleDeferred)
    }
  }
  const apply = (update: AgentStatusBatchUpdate): boolean => {
    const revision = owner.getAppRevision()
    const before = get()
    const previous = before.agentStatusByPaneKey[update.paneKey]
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
    const after = get()
    return (
      revision !== owner.getAppRevision() || previous !== after.agentStatusByPaneKey[update.paneKey]
    )
  }
  const transactAgentStatuses = <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ): Result =>
    owner.transact((transaction) => {
      if (generatedTitles) {
        return operation({ getState: get, apply, afterCommit: runAfterCommit })
      }
      generatedTitles = []
      freshnessRequested = false
      try {
        const result = operation({ getState: get, apply, afterCommit: runAfterCommit })
        const titles = generatedTitles
        if (titles.length > 0) {
          transaction.afterCommit(() => storeGet().setGeneratedTabTitlesFromAgentPrompts(titles))
        }
        if (freshnessRequested) {
          transaction.afterCommit(freshness.scheduleDeferred)
        }
        return result
      } finally {
        generatedTitles = null
        freshnessRequested = false
      }
    })

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
    authority: owner.authority,
    observations: owner.observations,
    get,
    set,
    setEntry,
    editEntries,
    runAfterCommit,
    applyGeneratedTabTitleUpdate,
    requestFreshness,
    freshness,
    transactAgentStatuses,
    clearSleepingAgentSessionsByPaneKey
  }
}
