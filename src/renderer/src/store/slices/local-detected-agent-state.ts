import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PathSource, ShellHydrationFailureReason, TuiAgent } from '../../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  getLocalAgentPreflightContext,
  localPreflightContextKey
} from '@/lib/local-preflight-context'

export type LocalDetectedAgentState = {
  detectedAgentIds: TuiAgent[] | null
  isDetectingAgents: boolean
  isRefreshingAgents: boolean
  localDetectedAgentIdsByContext: Record<string, TuiAgent[] | null>
  isDetectingLocalAgentsByContext: Record<string, boolean>
  isRefreshingLocalAgentsByContext: Record<string, boolean>
  pathSource: PathSource | null
  pathFailureReason: ShellHydrationFailureReason | null
  ensureDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  refreshDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  clearLocalDetectedAgents: () => void
}

export const createLocalDetectedAgentState: StateCreator<
  AppState,
  [],
  [],
  LocalDetectedAgentState
> = (set, get) => {
  const detectPromises = new Map<string, Promise<TuiAgent[]>>()
  const refreshPromises = new Map<string, Promise<TuiAgent[]>>()
  const failedDetectContextKeys = new Set<string>()
  const failedRefreshContextKeys = new Set<string>()
  const refreshMetadataByContext = new Map<
    string,
    { pathSource: PathSource; pathFailureReason: ShellHydrationFailureReason }
  >()
  let detectedContextKey: string | null = null
  let localDetectionGeneration = 0

  return {
    detectedAgentIds: null,
    isDetectingAgents: false,
    isRefreshingAgents: false,
    localDetectedAgentIdsByContext: {},
    isDetectingLocalAgentsByContext: {},
    isRefreshingLocalAgentsByContext: {},
    pathSource: null,
    pathFailureReason: null,

    ensureDetectedAgents: (worktreeId) => {
      const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localPreflightContextKey(context)
      const existing = get().localDetectedAgentIdsByContext[contextKey]
      if (existing != null && !failedDetectContextKeys.has(contextKey)) {
        if (!isFloating) {
          set({ detectedAgentIds: existing, isDetectingAgents: false })
          detectedContextKey = contextKey
        }
        return Promise.resolve(existing)
      }
      const requestGeneration = localDetectionGeneration
      const exposeToLegacy = (promise: Promise<TuiAgent[]>): Promise<TuiAgent[]> => {
        if (isFloating) {
          return promise
        }
        const contextChanged = detectedContextKey !== contextKey
        set({
          detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
          isDetectingAgents: true
        })
        return promise.then((ids) => {
          if (requestGeneration === localDetectionGeneration) {
            set({ detectedAgentIds: ids, isDetectingAgents: false })
            if (!failedDetectContextKeys.has(contextKey)) {
              detectedContextKey = contextKey
            }
          }
          return ids
        })
      }
      const inflight = detectPromises.get(contextKey)
      if (inflight) {
        return exposeToLegacy(inflight)
      }
      set({
        localDetectedAgentIdsByContext: {
          ...get().localDetectedAgentIdsByContext,
          [contextKey]: existing ?? null
        },
        isDetectingLocalAgentsByContext: {
          ...get().isDetectingLocalAgentsByContext,
          [contextKey]: true
        }
      })
      const pending = window.api.preflight
        .detectAgents(context)
        .then((ids) => {
          const typed = ids as TuiAgent[]
          if (requestGeneration === localDetectionGeneration) {
            failedDetectContextKeys.delete(contextKey)
            set((state) => ({
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isDetectingLocalAgentsByContext: {
                ...state.isDetectingLocalAgentsByContext,
                [contextKey]: false
              }
            }))
          }
          return typed
        })
        .catch(() => {
          if (requestGeneration === localDetectionGeneration) {
            failedDetectContextKeys.add(contextKey)
            set((state) => ({
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: []
              },
              isDetectingLocalAgentsByContext: {
                ...state.isDetectingLocalAgentsByContext,
                [contextKey]: false
              }
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
      return exposeToLegacy(pending)
    },

    refreshDetectedAgents: (worktreeId) => {
      const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localPreflightContextKey(context)
      const contextChanged = detectedContextKey !== contextKey
      const requestGeneration = localDetectionGeneration
      const exposeToLegacy = (promise: Promise<TuiAgent[]>): Promise<TuiAgent[]> => {
        if (isFloating) {
          return promise
        }
        set({
          detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
          isRefreshingAgents: true
        })
        return promise.then((ids) => {
          if (requestGeneration === localDetectionGeneration) {
            const metadata = refreshMetadataByContext.get(contextKey)
            set({
              detectedAgentIds: ids,
              isRefreshingAgents: false,
              pathSource: metadata?.pathSource ?? get().pathSource,
              pathFailureReason: metadata?.pathFailureReason ?? get().pathFailureReason
            })
            if (!failedRefreshContextKeys.has(contextKey)) {
              detectedContextKey = contextKey
            }
          }
          return ids
        })
      }
      const inflight = refreshPromises.get(contextKey)
      if (inflight) {
        return exposeToLegacy(inflight)
      }
      set({
        isRefreshingLocalAgentsByContext: {
          ...get().isRefreshingLocalAgentsByContext,
          [contextKey]: true
        }
      })
      const pending = window.api.preflight
        .refreshAgents(context)
        .then((result) => {
          const typed = result.agents as TuiAgent[]
          if (requestGeneration === localDetectionGeneration) {
            failedDetectContextKeys.delete(contextKey)
            failedRefreshContextKeys.delete(contextKey)
            refreshMetadataByContext.set(contextKey, {
              pathSource: result.pathSource,
              pathFailureReason: result.pathFailureReason
            })
            set((state) => ({
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isRefreshingLocalAgentsByContext: {
                ...state.isRefreshingLocalAgentsByContext,
                [contextKey]: false
              }
            }))
          }
          return typed
        })
        .catch(() => {
          const fallback = isFloating
            ? (get().localDetectedAgentIdsByContext[contextKey] ?? [])
            : contextChanged
              ? []
              : (get().detectedAgentIds ?? [])
          if (requestGeneration === localDetectionGeneration) {
            failedRefreshContextKeys.add(contextKey)
            refreshMetadataByContext.delete(contextKey)
            set((state) => ({
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: fallback
              },
              isRefreshingLocalAgentsByContext: {
                ...state.isRefreshingLocalAgentsByContext,
                [contextKey]: false
              }
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
      return exposeToLegacy(pending)
    },

    clearLocalDetectedAgents: () => {
      localDetectionGeneration += 1
      detectPromises.clear()
      refreshPromises.clear()
      failedDetectContextKeys.clear()
      failedRefreshContextKeys.clear()
      refreshMetadataByContext.clear()
      detectedContextKey = null
      set({
        detectedAgentIds: null,
        isDetectingAgents: false,
        isRefreshingAgents: false,
        localDetectedAgentIdsByContext: {},
        isDetectingLocalAgentsByContext: {},
        isRefreshingLocalAgentsByContext: {},
        pathSource: null,
        pathFailureReason: null
      })
    }
  }
}
