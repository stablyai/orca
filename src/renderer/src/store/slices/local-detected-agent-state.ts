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
  markLocalAgentRefusal,
  refreshLocalAgentInventory,
  type LocalAgentInventoryLifecycle
} from './local-agent-inventory-refresh'
import {
  createEmptyLocalDetectedAgentState,
  type LocalAgentRefreshOptions,
  type LocalDetectedAgentState
} from './local-detected-agent-store-state'
import { readLocalAgentInventoryOutcome } from './local-agent-inventory-outcome'

type LocalDetectedAgentStateCreator = StateCreator<AppState, [], [], LocalDetectedAgentState>

export const createLocalDetectedAgentState: LocalDetectedAgentStateCreator = (set, get, store) => {
  let nativeInventoryRequested = false
  const lifecycle: LocalAgentInventoryLifecycle = {
    detectPromises: new Map(),
    refreshPromises: new Map(),
    wakeRefreshes: new WeakSet(),
    wakeDetects: new WeakSet(),
    refusedContextKeys: new Set(),
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
    isLocalAgentInventoryRefused: (worktreeId?: string | null): boolean =>
      lifecycle.refusedContextKeys.has(
        localAgentInventoryContextKey(
          getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
        )
      ),
    ensureDetectedAgentsForPicker: (worktreeId?: string | null): Promise<TuiAgent[]> =>
      actions.ensureDetectedAgents(worktreeId, false, false, { wakeWslDistro: true }),
    ensureDetectedAgents: (
      worktreeId?: string | null,
      nativeHost = false,
      includeDisabled = false,
      options: LocalAgentRefreshOptions = {}
    ): Promise<TuiAgent[]> => {
      const wake = options.wakeWslDistro === true
      const isolatedInventory =
        includeDisabled || nativeHost || worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = nativeHost
        ? undefined
        : getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localAgentInventoryContextKey(context, includeDisabled)
      const existing = get().localDetectedAgentIdsByContext[contextKey]
      const inflightRefresh = lifecycle.refreshPromises.get(contextKey)
      // A picker's wake must not ride a background probe that a stopped WSL distro refuses.
      if (inflightRefresh && (!wake || lifecycle.wakeRefreshes.has(inflightRefresh))) {
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
      if (inflight && (!wake || lifecycle.wakeDetects.has(inflight))) {
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
      const detectArgs = includeDisabled ? context : { ...context, enabledOnly: true }
      const pending = window.api.preflight
        .detectAgents(wake ? { ...detectArgs, wakeWslDistro: true } : detectArgs)
        .then((ids) => {
          const typed = ids.filter(isTuiAgent)
          if (
            requestGeneration === lifecycle.localDetectionGeneration &&
            lifecycle.detectPromises.get(contextKey) === pending
          ) {
            lifecycle.refusedContextKeys.delete(contextKey)
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
        .catch((error: unknown): TuiAgent[] => {
          if (
            requestGeneration === lifecycle.localDetectionGeneration &&
            lifecycle.detectPromises.get(contextKey) === pending
          ) {
            lifecycle.failedDetectContextKeys.add(contextKey)
            markLocalAgentRefusal(lifecycle, contextKey, error)
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
      if (wake) {
        lifecycle.wakeDetects.add(pending)
      }
      lifecycle.detectPromises.set(contextKey, pending)
      return pending
    },

    refreshAllDetectedAgents: (
      worktreeId?: string | null,
      options?: LocalAgentRefreshOptions
    ): Promise<TuiAgent[]> =>
      refreshLocalAgentInventory(set, get, lifecycle, worktreeId, true, options),
    refreshDetectedAgents: (worktreeId?: string | null, options?: LocalAgentRefreshOptions) =>
      refreshLocalAgentInventory(set, get, lifecycle, worktreeId, false, options),

    clearLocalDetectedAgentContextsForProjects: (projectIds: readonly string[]) => {
      const eviction = contextEviction.getLocalAgentContextEviction({
        projectIds,
        state: get(),
        internalContextKeys: [
          ...lifecycle.detectPromises.keys(),
          ...lifecycle.refreshPromises.keys(),
          ...lifecycle.failedDetectContextKeys,
          ...lifecycle.refusedContextKeys
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
        lifecycle.refusedContextKeys.delete(contextKey)
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
      lifecycle.refusedContextKeys.clear()
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
