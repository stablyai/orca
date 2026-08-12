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
      if (existing) {
        return Promise.resolve(existing)
      }
      const inflight = detectPromises.get(contextKey)
      if (inflight) {
        return inflight
      }
      const contextChanged = detectedContextKey !== contextKey
      set({
        ...(isFloating
          ? {}
          : {
              detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
              isDetectingAgents: true
            }),
        localDetectedAgentIdsByContext: {
          ...get().localDetectedAgentIdsByContext,
          [contextKey]: existing ?? null
        },
        isDetectingLocalAgentsByContext: {
          ...get().isDetectingLocalAgentsByContext,
          [contextKey]: true
        }
      })
      const requestGeneration = localDetectionGeneration
      const pending = window.api.preflight
        .detectAgents(context)
        .then((ids) => {
          const typed = ids as TuiAgent[]
          if (requestGeneration === localDetectionGeneration) {
            set((state) => ({
              ...(isFloating ? {} : { detectedAgentIds: typed, isDetectingAgents: false }),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isDetectingLocalAgentsByContext: {
                ...state.isDetectingLocalAgentsByContext,
                [contextKey]: false
              }
            }))
            if (!isFloating) {
              detectedContextKey = contextKey
            }
          }
          return typed
        })
        .catch(() => {
          if (requestGeneration === localDetectionGeneration) {
            set((state) => ({
              ...(isFloating
                ? {}
                : {
                    detectedAgentIds: contextChanged ? [] : get().detectedAgentIds,
                    isDetectingAgents: false
                  }),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: contextChanged ? [] : (existing ?? [])
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
      return pending
    },

    refreshDetectedAgents: (worktreeId) => {
      const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
      const contextKey = localPreflightContextKey(context)
      const inflight = refreshPromises.get(contextKey)
      if (inflight) {
        return inflight
      }
      const contextChanged = detectedContextKey !== contextKey
      set({
        ...(isFloating
          ? {}
          : {
              detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
              isRefreshingAgents: true
            }),
        isRefreshingLocalAgentsByContext: {
          ...get().isRefreshingLocalAgentsByContext,
          [contextKey]: true
        }
      })
      const requestGeneration = localDetectionGeneration
      const pending = window.api.preflight
        .refreshAgents(context)
        .then((result) => {
          const typed = result.agents as TuiAgent[]
          if (requestGeneration === localDetectionGeneration) {
            set((state) => ({
              ...(isFloating
                ? {}
                : {
                    detectedAgentIds: typed,
                    isRefreshingAgents: false,
                    pathSource: result.pathSource,
                    pathFailureReason: result.pathFailureReason
                  }),
              localDetectedAgentIdsByContext: {
                ...state.localDetectedAgentIdsByContext,
                [contextKey]: typed
              },
              isRefreshingLocalAgentsByContext: {
                ...state.isRefreshingLocalAgentsByContext,
                [contextKey]: false
              }
            }))
            if (!isFloating) {
              detectedContextKey = contextKey
            }
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
            set((state) => ({
              ...(isFloating ? {} : { detectedAgentIds: fallback, isRefreshingAgents: false }),
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
      return pending
    },

    clearLocalDetectedAgents: () => {
      localDetectionGeneration += 1
      detectPromises.clear()
      refreshPromises.clear()
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
