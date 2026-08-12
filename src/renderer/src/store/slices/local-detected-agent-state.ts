import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  getLocalAgentPreflightContext,
  localPreflightContextKey
} from '@/lib/local-preflight-context'
import * as contextEviction from './local-agent-context-eviction'
import { getLegacyLoadingPatch, getSupersededDetectPatch } from './local-agent-legacy-loading'
import { createEmptyLocalDetectedAgentState } from './local-detected-agent-store-state'
import type { LocalDetectedAgentState } from './local-detected-agent-store-state'

type LocalDetectedAgentStateCreator = StateCreator<AppState, [], [], LocalDetectedAgentState>

export const createLocalDetectedAgentState: LocalDetectedAgentStateCreator = (set, get) => {
  const detectPromises = new Map<string, Promise<TuiAgent[]>>()
  const refreshPromises = new Map<string, Promise<TuiAgent[]>>()
  const failedDetectContextKeys = new Set<string>()
  let detectedContextKey: string | null = null
  let legacyDetectContextKey: string | null = null
  let legacyRefreshContextKey: string | null = null
  let localDetectionGeneration = 0

  return {
    ...createEmptyLocalDetectedAgentState(),

    ensureDetectedAgents: (worktreeId) => {
      const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localPreflightContextKey(context)
      const existing = get().localDetectedAgentIdsByContext[contextKey]
      const inflightRefresh = refreshPromises.get(contextKey)
      if (inflightRefresh) {
        if (!isFloating) {
          legacyRefreshContextKey = contextKey
        }
        return inflightRefresh
      }
      if (existing != null && !failedDetectContextKeys.has(contextKey)) {
        if (!isFloating) {
          detectedContextKey = contextKey
          const state = get()
          if (state.detectedAgentIds !== existing || state.isDetectingAgents) {
            set({ detectedAgentIds: existing, isDetectingAgents: false })
          }
        }
        return Promise.resolve(existing)
      }
      const requestGeneration = localDetectionGeneration
      const exposeInflightToLegacy = (): void => {
        if (!isFloating) {
          legacyDetectContextKey = contextKey
        }
        if (isFloating) {
          return
        }
        const state = get()
        const patch = getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'detect')
        if (patch) {
          set(patch)
        }
      }
      const inflight = detectPromises.get(contextKey)
      if (inflight) {
        exposeInflightToLegacy()
        return inflight
      }
      if (!isFloating) {
        legacyDetectContextKey = contextKey
      }
      set((state) => ({
        ...(isFloating
          ? {}
          : (getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'detect') ?? {})),
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
        .detectAgents(context)
        .then((ids) => {
          const typed = ids as TuiAgent[]
          if (
            requestGeneration === localDetectionGeneration &&
            detectPromises.get(contextKey) === pending
          ) {
            failedDetectContextKeys.delete(contextKey)
            const exposeToLegacy = legacyDetectContextKey === contextKey
            if (exposeToLegacy) {
              legacyDetectContextKey = null
              detectedContextKey = contextKey
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
        .catch(() => {
          if (
            requestGeneration === localDetectionGeneration &&
            detectPromises.get(contextKey) === pending
          ) {
            failedDetectContextKeys.add(contextKey)
            const exposeToLegacy = legacyDetectContextKey === contextKey
            if (exposeToLegacy) {
              legacyDetectContextKey = null
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
          return [] as TuiAgent[]
        })
        .finally(() => {
          if (detectPromises.get(contextKey) === pending) {
            detectPromises.delete(contextKey)
          }
        })
      detectPromises.set(contextKey, pending)
      return pending
    },

    refreshDetectedAgents: (worktreeId) => {
      const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localPreflightContextKey(context)
      const cached = get().localDetectedAgentIdsByContext[contextKey]
      const hadUsableCache = cached != null && !failedDetectContextKeys.has(contextKey)
      const requestGeneration = localDetectionGeneration
      const exposeInflightToLegacy = (): void => {
        if (!isFloating) {
          legacyRefreshContextKey = contextKey
        }
        if (isFloating) {
          return
        }
        const state = get()
        const patch = getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'refresh')
        if (patch) {
          set(patch)
        }
      }
      const inflight = refreshPromises.get(contextKey)
      if (inflight) {
        exposeInflightToLegacy()
        return inflight
      }
      if (!isFloating) {
        legacyRefreshContextKey = contextKey
      }
      const supersedesDetect = detectPromises.delete(contextKey)
      const clearsLegacyDetect = legacyDetectContextKey === contextKey
      if (clearsLegacyDetect) {
        legacyDetectContextKey = null
      }
      set((state) => ({
        ...(isFloating
          ? {}
          : (getLegacyLoadingPatch(state, detectedContextKey === contextKey, 'refresh') ?? {})),
        ...getSupersededDetectPatch(state, contextKey, supersedesDetect, clearsLegacyDetect),
        isRefreshingLocalAgentsByContext: {
          ...state.isRefreshingLocalAgentsByContext,
          [contextKey]: true
        }
      }))
      const pending = window.api.preflight
        .refreshAgents(context)
        .then((result) => {
          const typed = result.agents as TuiAgent[]
          if (
            requestGeneration === localDetectionGeneration &&
            refreshPromises.get(contextKey) === pending
          ) {
            failedDetectContextKeys.delete(contextKey)
            const exposeToLegacy = legacyRefreshContextKey === contextKey
            if (exposeToLegacy) {
              legacyRefreshContextKey = null
              detectedContextKey = contextKey
            }
            set((state) => ({
              ...(exposeToLegacy
                ? {
                    detectedAgentIds: typed,
                    isRefreshingAgents: false,
                    pathSource: result.pathSource,
                    pathFailureReason: result.pathFailureReason
                  }
                : {}),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isRefreshingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isRefreshingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return typed
        })
        .catch(() => {
          const fallback = isFloating
            ? (get().localDetectedAgentIdsByContext[contextKey] ?? [])
            : detectedContextKey !== contextKey
              ? []
              : (get().detectedAgentIds ?? [])
          if (
            requestGeneration === localDetectionGeneration &&
            refreshPromises.get(contextKey) === pending
          ) {
            if (!hadUsableCache) {
              failedDetectContextKeys.add(contextKey)
            }
            const exposeToLegacy = legacyRefreshContextKey === contextKey
            if (exposeToLegacy) {
              legacyRefreshContextKey = null
            }
            set((state) => ({
              ...(exposeToLegacy ? { detectedAgentIds: fallback, isRefreshingAgents: false } : {}),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: fallback
              },
              isRefreshingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntry(
                state.isRefreshingLocalAgentsByContext,
                contextKey
              )
            }))
          }
          return fallback
        })
        .finally(() => {
          if (refreshPromises.get(contextKey) === pending) {
            refreshPromises.delete(contextKey)
          }
        })
      refreshPromises.set(contextKey, pending)
      return pending
    },

    clearLocalDetectedAgentContextsForProjects: (projectIds) => {
      const eviction = contextEviction.getLocalAgentContextEviction({
        projectIds,
        state: get(),
        internalContextKeys: [
          ...detectPromises.keys(),
          ...refreshPromises.keys(),
          ...failedDetectContextKeys
        ],
        detectedContextKey,
        legacyDetectContextKey,
        legacyRefreshContextKey
      })
      if (!eviction) {
        return
      }
      for (const contextKey of eviction.removedContextKeys) {
        detectPromises.delete(contextKey)
        refreshPromises.delete(contextKey)
        failedDetectContextKeys.delete(contextKey)
      }
      detectedContextKey = eviction.detectedContextKey
      legacyDetectContextKey = eviction.legacyDetectContextKey
      legacyRefreshContextKey = eviction.legacyRefreshContextKey
      set(eviction.statePatch)
    },

    clearLocalDetectedAgents: () => {
      localDetectionGeneration += 1
      detectPromises.clear()
      refreshPromises.clear()
      failedDetectContextKeys.clear()
      detectedContextKey = null
      legacyDetectContextKey = null
      legacyRefreshContextKey = null
      set(createEmptyLocalDetectedAgentState())
    }
  }
}
