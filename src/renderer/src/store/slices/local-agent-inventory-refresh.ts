import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import * as contextEviction from './local-agent-context-eviction'
import { getLegacyLoadingPatch, getSupersededDetectPatch } from './local-agent-legacy-loading'

export type LocalAgentInventoryLifecycle = {
  detectPromises: Map<string, Promise<TuiAgent[]>>
  refreshPromises: Map<string, Promise<TuiAgent[]>>
  keptThroughFailure: WeakSet<TuiAgent[]>
  failedDetectContextKeys: Set<string>
  detectedContextKey: string | null
  legacyDetectContextKey: string | null
  legacyRefreshContextKey: string | null
  localDetectionGeneration: number
}

export function refreshLocalAgentInventory(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  lifecycle: LocalAgentInventoryLifecycle,
  worktreeId?: string | null,
  includeDisabled = false
): Promise<TuiAgent[]> {
  const isolatedInventory = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const context = getLocalAgentPreflightContext(get(), undefined, undefined, worktreeId)
  const contextKey = localAgentInventoryContextKey(context, includeDisabled)
  const publishedContextKey = localAgentInventoryContextKey(context)
  const refreshContextKeys = new Set([contextKey, publishedContextKey])
  const cached = get().localDetectedAgentIdsByContext[contextKey]
  const hadUsableCache = cached != null && !lifecycle.failedDetectContextKeys.has(contextKey)
  const publishedHadUsableCache =
    get().localDetectedAgentIdsByContext[publishedContextKey] != null &&
    !lifecycle.failedDetectContextKeys.has(publishedContextKey)
  const requestGeneration = lifecycle.localDetectionGeneration
  const exposeInflightToLegacy = (): void => {
    if (!isolatedInventory) {
      lifecycle.legacyRefreshContextKey = contextKey
    }
    if (isolatedInventory) {
      return
    }
    const state = get()
    const patch = getLegacyLoadingPatch(
      state,
      lifecycle.detectedContextKey === publishedContextKey,
      'refresh'
    )
    if (patch) {
      set(patch)
    }
  }
  const inflight = lifecycle.refreshPromises.get(contextKey)
  if (inflight) {
    exposeInflightToLegacy()
    return inflight
  }
  if (!isolatedInventory) {
    lifecycle.legacyRefreshContextKey = contextKey
  }
  lifecycle.detectPromises.delete(contextKey)
  if (includeDisabled) {
    lifecycle.detectPromises.delete(publishedContextKey)
    lifecycle.refreshPromises.delete(publishedContextKey)
  }
  const clearsLegacyDetect =
    lifecycle.legacyDetectContextKey !== null &&
    refreshContextKeys.has(lifecycle.legacyDetectContextKey)
  if (clearsLegacyDetect) {
    lifecycle.legacyDetectContextKey = null
  }
  set((state) => ({
    ...(isolatedInventory
      ? {}
      : (getLegacyLoadingPatch(
          state,
          lifecycle.detectedContextKey === publishedContextKey,
          'refresh'
        ) ?? {})),
    ...getSupersededDetectPatch(state, refreshContextKeys, clearsLegacyDetect),
    isRefreshingLocalAgentsByContext: {
      ...state.isRefreshingLocalAgentsByContext,
      [contextKey]: true,
      [publishedContextKey]: true
    }
  }))
  const pending = window.api.preflight
    .refreshAgents(includeDisabled ? context : { ...context, enabledOnly: true })
    .then((result) => {
      const typed = result.agents.filter(isTuiAgent)
      const published = includeDisabled
        ? filterEnabledTuiAgents(typed, get().settings?.disabledTuiAgents)
        : typed
      if (
        requestGeneration === lifecycle.localDetectionGeneration &&
        lifecycle.refreshPromises.get(contextKey) === pending
      ) {
        lifecycle.failedDetectContextKeys.delete(contextKey)
        lifecycle.failedDetectContextKeys.delete(publishedContextKey)
        const exposeToLegacy =
          lifecycle.legacyRefreshContextKey !== null &&
          refreshContextKeys.has(lifecycle.legacyRefreshContextKey)
        if (exposeToLegacy) {
          lifecycle.legacyRefreshContextKey = null
          lifecycle.detectedContextKey = publishedContextKey
        }
        set((state) => ({
          ...(exposeToLegacy
            ? {
                detectedAgentIds: published,
                isRefreshingAgents: false,
                pathSource: result.pathSource,
                pathFailureReason: result.pathFailureReason
              }
            : {}),
          localDetectedAgentIdsByContext: {
            ...state.localDetectedAgentIdsByContext,
            [contextKey]: typed,
            [publishedContextKey]: published
          },
          isRefreshingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntries(
            state.isRefreshingLocalAgentsByContext,
            refreshContextKeys
          )
        }))
      }
      return typed
    })
    .catch(() => {
      const fallback = get().localDetectedAgentIdsByContext[contextKey] ?? []
      if (
        requestGeneration === lifecycle.localDetectionGeneration &&
        lifecycle.refreshPromises.get(contextKey) === pending
      ) {
        lifecycle.keptThroughFailure.add(fallback)
        const publishedFallback = get().localDetectedAgentIdsByContext[publishedContextKey] ?? []
        lifecycle.keptThroughFailure.add(publishedFallback)
        if (!publishedHadUsableCache) {
          lifecycle.failedDetectContextKeys.add(publishedContextKey)
        }
        if (!hadUsableCache) {
          lifecycle.failedDetectContextKeys.add(contextKey)
        }
        const exposeToLegacy =
          lifecycle.legacyRefreshContextKey !== null &&
          refreshContextKeys.has(lifecycle.legacyRefreshContextKey)
        if (exposeToLegacy) {
          lifecycle.legacyRefreshContextKey = null
          lifecycle.detectedContextKey = publishedContextKey
        }
        set((state) => ({
          ...(exposeToLegacy
            ? { detectedAgentIds: publishedFallback, isRefreshingAgents: false }
            : {}),
          localDetectedAgentIdsByContext: {
            ...state.localDetectedAgentIdsByContext,
            [contextKey]: fallback,
            [publishedContextKey]: publishedFallback
          },
          isRefreshingLocalAgentsByContext: contextEviction.removeLocalAgentContextEntries(
            state.isRefreshingLocalAgentsByContext,
            refreshContextKeys
          )
        }))
      }
      return fallback
    })
    .finally(() => {
      if (lifecycle.refreshPromises.get(contextKey) === pending) {
        lifecycle.refreshPromises.delete(contextKey)
      }
    })
  const publishedPending = includeDisabled
    ? pending.then(() => get().localDetectedAgentIdsByContext[publishedContextKey] ?? [])
    : pending
  if (includeDisabled) {
    lifecycle.refreshPromises.set(publishedContextKey, publishedPending)
    void publishedPending.finally(() => {
      if (lifecycle.refreshPromises.get(publishedContextKey) === publishedPending) {
        lifecycle.refreshPromises.delete(publishedContextKey)
      }
    })
  }
  lifecycle.refreshPromises.set(contextKey, pending)
  return pending
}
