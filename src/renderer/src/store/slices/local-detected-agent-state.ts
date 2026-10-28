import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { haveSameDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import * as contextEviction from './local-agent-context-eviction'
import { getLegacyLoadingPatch } from './local-agent-legacy-loading'
import {
  refreshLocalAgentInventory,
  type LocalAgentInventoryLifecycle
} from './local-agent-inventory-refresh'
import { createEmptyLocalDetectedAgentState } from './local-detected-agent-store-state'
import { readLocalAgentInventoryOutcome } from './local-agent-inventory-outcome'
import type { LocalDetectedAgentState } from './local-detected-agent-store-state'

type LocalDetectedAgentStateCreator = StateCreator<AppState, [], [], LocalDetectedAgentState>

export const createLocalDetectedAgentState: LocalDetectedAgentStateCreator = (set, get, store) => {
  let nativeInventoryRequested = false
  const lifecycle: LocalAgentInventoryLifecycle = {
    detectPromises: new Map(),
    refreshPromises: new Map(),
    keptThroughFailure: new WeakSet(),
    failedDetectContextKeys: new Set(),
    detectedContextKey: null,
    legacyDetectContextKey: null,
    legacyRefreshContextKey: null,
    localDetectionGeneration: 0
  }

  const actions = {
    ...createEmptyLocalDetectedAgentState(),

    readLocalAgentInventory: (id?: string | null) =>
      readLocalAgentInventoryOutcome(
        get(),
        id,
        lifecycle.failedDetectContextKeys,
        lifecycle.keptThroughFailure
      ),
    ensureNativeDetectedAgents: (): Promise<TuiAgent[]> => {
      nativeInventoryRequested = true
      return actions.ensureDetectedAgents(undefined, true)
    },
    ensureAllDetectedAgents: (worktreeId?: string | null): Promise<TuiAgent[]> =>
      actions.ensureDetectedAgents(worktreeId, false, true),
    ensureDetectedAgents: (
      worktreeId?: string | null,
      nativeHost = false,
      includeDisabled = false
    ): Promise<TuiAgent[]> => {
      const isolatedInventory =
        includeDisabled || nativeHost || worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = nativeHost
        ? undefined
        : getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localAgentInventoryContextKey(context, includeDisabled)
      const existing = get().localDetectedAgentIdsByContext[contextKey]
      const inflightRefresh = lifecycle.refreshPromises.get(contextKey)
      if (inflightRefresh) {
        if (!isolatedInventory) {
          lifecycle.legacyRefreshContextKey = contextKey
        }
        return inflightRefresh
      }
      if (existing != null && !lifecycle.failedDetectContextKeys.has(contextKey)) {
        if (!isolatedInventory) {
          lifecycle.detectedContextKey = contextKey
          const state = get()
          if (state.detectedAgentIds !== existing || state.isDetectingAgents) {
            set({ detectedAgentIds: existing, isDetectingAgents: false })
          }
        }
        return Promise.resolve(existing)
      }
      const requestGeneration = lifecycle.localDetectionGeneration
      const exposeInflightToLegacy = (): void => {
        if (!isolatedInventory) {
          lifecycle.legacyDetectContextKey = contextKey
        }
        if (isolatedInventory) {
          return
        }
        const state = get()
        const patch = getLegacyLoadingPatch(
          state,
          lifecycle.detectedContextKey === contextKey,
          'detect'
        )
        if (patch) {
          set(patch)
        }
      }
      const inflight = lifecycle.detectPromises.get(contextKey)
      if (inflight) {
        exposeInflightToLegacy()
        return inflight
      }
      if (!isolatedInventory) {
        lifecycle.legacyDetectContextKey = contextKey
      }
      set((state) => ({
        ...(isolatedInventory
          ? {}
          : (getLegacyLoadingPatch(state, lifecycle.detectedContextKey === contextKey, 'detect') ??
            {})),
        localDetectedAgentIdsByContext: {
          ...state.localDetectedAgentIdsByContext,
          [contextKey]: existing ?? null
        },
        isDetectingLocalAgentsByContext: {
          ...state.isDetectingLocalAgentsByContext,
          [contextKey]: true
        }
      }))
      const pending = window.api.preflight
        .detectAgents(includeDisabled ? context : { ...context, enabledOnly: true })
        .then((ids) => {
          const typed = ids.filter(isTuiAgent)
          if (
            requestGeneration === lifecycle.localDetectionGeneration &&
            lifecycle.detectPromises.get(contextKey) === pending
          ) {
            lifecycle.failedDetectContextKeys.delete(contextKey)
            const exposeToLegacy = lifecycle.legacyDetectContextKey === contextKey
            if (exposeToLegacy) {
              lifecycle.legacyDetectContextKey = null
              lifecycle.detectedContextKey = contextKey
            }
            set((state) => ({
              ...(exposeToLegacy ? { detectedAgentIds: typed, isDetectingAgents: false } : {}),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isDetectingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isDetectingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return typed
        })
        .catch((): TuiAgent[] => {
          if (
            requestGeneration === lifecycle.localDetectionGeneration &&
            lifecycle.detectPromises.get(contextKey) === pending
          ) {
            lifecycle.failedDetectContextKeys.add(contextKey)
            const exposeToLegacy = lifecycle.legacyDetectContextKey === contextKey
            if (exposeToLegacy) {
              lifecycle.legacyDetectContextKey = null
            }
            set((state) => ({
              ...(exposeToLegacy ? { detectedAgentIds: [], isDetectingAgents: false } : {}),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: []
              },
              isDetectingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isDetectingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return []
        })
        .finally(() => {
          if (lifecycle.detectPromises.get(contextKey) === pending) {
            lifecycle.detectPromises.delete(contextKey)
          }
        })
      lifecycle.detectPromises.set(contextKey, pending)
      return pending
    },

    refreshAllDetectedAgents: (worktreeId?: string | null): Promise<TuiAgent[]> =>
      actions.refreshDetectedAgents(worktreeId, true),
    refreshDetectedAgents: (worktreeId?: string | null, includeDisabled = false) =>
      refreshLocalAgentInventory(set, get, lifecycle, worktreeId, includeDisabled),

    clearLocalDetectedAgentContextsForProjects: (projectIds: readonly string[]) => {
      const eviction = contextEviction.getLocalAgentContextEviction({
        projectIds,
        state: get(),
        internalContextKeys: [
          ...lifecycle.detectPromises.keys(),
          ...lifecycle.refreshPromises.keys(),
          ...lifecycle.failedDetectContextKeys
        ],
        detectedContextKey: lifecycle.detectedContextKey,
        legacyDetectContextKey: lifecycle.legacyDetectContextKey,
        legacyRefreshContextKey: lifecycle.legacyRefreshContextKey
      })
      if (!eviction) {
        return
      }
      for (const contextKey of eviction.removedContextKeys) {
        lifecycle.detectPromises.delete(contextKey)
        lifecycle.refreshPromises.delete(contextKey)
        lifecycle.failedDetectContextKeys.delete(contextKey)
      }
      lifecycle.detectedContextKey = eviction.detectedContextKey
      lifecycle.legacyDetectContextKey = eviction.legacyDetectContextKey
      lifecycle.legacyRefreshContextKey = eviction.legacyRefreshContextKey
      set(eviction.statePatch)
    },

    clearLocalDetectedAgents: () => {
      nativeInventoryRequested = false
      lifecycle.localDetectionGeneration += 1
      lifecycle.detectPromises.clear()
      lifecycle.refreshPromises.clear()
      lifecycle.failedDetectContextKeys.clear()
      lifecycle.detectedContextKey = null
      lifecycle.legacyDetectContextKey = null
      lifecycle.legacyRefreshContextKey = null
      set(createEmptyLocalDetectedAgentState())
    }
  }
  store.subscribe((state, previous) => {
    if (state.settings?.disabledTuiAgents === previous.settings?.disabledTuiAgents) {
      return
    }
    if (
      !haveSameDisabledTuiAgents(
        state.settings?.disabledTuiAgents,
        previous.settings?.disabledTuiAgents
      )
    ) {
      const reacquireNativeInventory = nativeInventoryRequested
      actions.clearLocalDetectedAgents()
      // Native consumers can remain mounted while workspace consumers reacquire only WSL.
      if (reacquireNativeInventory) {
        void actions.ensureNativeDetectedAgents()
      }
    }
  })
  return actions
}
