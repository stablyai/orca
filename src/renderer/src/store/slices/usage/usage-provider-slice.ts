import type { StateCreator } from 'zustand'
import type {
  UsageApi,
  ProviderUsageSlice,
  UsageProviderConfig
} from './usage-provider-slice-contract'
import type { AppState } from '../../types'

import type { UsageSnapshot, UsageProviderTypes } from './usage-provider-types'

import { createUsagePatch, createInitialUsageData } from './usage-provider-slice-state'
import { createUsageProviderHostWrites } from './usage-provider-host-writes'

export function createUsageProviderSlice<
  Prefix extends string,
  Name extends string,
  T extends UsageProviderTypes<string, string, UsageSnapshot>
>(
  config: UsageProviderConfig<Prefix, Name, T>
): StateCreator<AppState, [], [], ProviderUsageSlice<Prefix, Name, T>> {
  return (set, get) => {
    const { shownView, read, update, updateFailure, stopLoading, markLoading } =
      createUsageProviderHostWrites<T>(config.prefix, set, get)

    type Intent = 0 | 1 | 2
    type Operation = {
      /** The Stats host view this operation serves; a host switch starts a new one. */
      view: number
      /** The view changed; this operation must neither write nor run queued intents. */
      abandoned: boolean
      intent: Intent
      phase: 'reading' | 'refreshing' | 'projecting'
      disconnected: boolean
      readOnFailure: boolean
      promise: Promise<void>
    }
    let operation: Operation | null = null
    let pending: Intent | null = null
    const queueIntent = (intent: Intent): void => {
      pending = pending === null || intent > pending ? intent : pending
    }
    const project = async (
      api: UsageApi<T>,
      current: Operation,
      beforeRefresh: boolean
    ): Promise<T['snapshot']['scanState'] | undefined> => {
      while (!current.disconnected) {
        const { scope, range } = read()
        const snapshot = await api.getSnapshot(
          { scope, range, limit: 10 },
          current.intent === 0 ? 'recovery' : undefined
        )
        if (current.disconnected) {
          return
        }
        if (scope !== read().scope || range !== read().range) {
          continue
        }
        const loading = pending === 2 || (beforeRefresh && current.intent === 2)
        if (
          beforeRefresh &&
          current.intent > 0 &&
          snapshot.scanState.lastScanCompletedAt === null &&
          !config.hasCachedData(snapshot.scanState)
        ) {
          update(current.view, {
            scanState: { ...snapshot.scanState, isScanning: true, lastScanError: null }
          })
        } else {
          update(current.view, {
            ...snapshot,
            scanState: loading ? { ...snapshot.scanState, isScanning: true } : snapshot.scanState
          })
        }
        return snapshot.scanState
      }
      return undefined
    }
    const request = (intent: Intent, recovery = false): Promise<void> => {
      const target = get().statsHost
      const view = get().statsHostEpoch
      if (intent === 2) {
        markLoading(view)
      }
      if (operation && operation.view !== view) {
        operation.abandoned = true
        operation.disconnected = true
        operation = null
        pending = null
      }
      if (operation) {
        if (recovery) {
          operation.readOnFailure = true
          if (operation.disconnected) {
            queueIntent(0)
          }
        } else if (
          operation.disconnected ||
          intent > operation.intent ||
          (intent > 0 && operation.phase === 'projecting')
        ) {
          queueIntent(intent)
        }
        return operation.promise
      }
      const current: Operation = {
        view,
        abandoned: false,
        intent,
        phase: 'reading',
        disconnected: false,
        readOnFailure: false,
        promise: Promise.resolve()
      }
      operation = current
      const api = config.getApi(target)
      const unsubscribe = api.onConnectionChanged?.((connected, detail) => {
        if (detail?.initial || detail?.unavailable) {
          return
        }
        if (!connected && operation === current) {
          if (current.intent === 2 || pending === 2) {
            updateFailure(view, { refresh: true })
          }
          current.disconnected = true
          current.readOnFailure = false
          pending = null
          stopLoading(view)
        }
      })
      // Publish the operation before the first port handshake can notify mounted readers.
      current.promise = Promise.resolve()
        .then(async () => {
          let next: Intent | null = intent
          while (next !== null && !current.abandoned) {
            current.intent = next
            current.phase = 'reading'
            current.disconnected = false
            current.readOnFailure = false
            pending = null
            try {
              const state = await api.getScanState(next === 0 ? 'recovery' : undefined)
              if (current.disconnected) {
                throw new Error('Usage disconnected.')
              }
              if (state) {
                update(view, {
                  scanState:
                    (next === 2 || pending === 2) && state.enabled
                      ? { ...state, isScanning: true }
                      : state
                })
                if (state.enabled) {
                  const baseline = await project(api, current, next > 0)
                  if (current.disconnected) {
                    throw new Error('Usage disconnected.')
                  }
                  if (next > 0) {
                    current.phase = 'refreshing'
                    const olderFailure = read().failure
                    const refreshed = await api.refresh({ force: next === 2 })
                    if (current.disconnected) {
                      throw new Error('Usage disconnected.')
                    }
                    current.phase = 'projecting'
                    const completed = await project(api, current, false)
                    if (current.disconnected) {
                      throw new Error('Usage disconnected.')
                    }
                    if (
                      completed?.enabled &&
                      !completed.isScanning &&
                      !completed.lastScanError &&
                      ((next === 2 &&
                        refreshed &&
                        !refreshed.isScanning &&
                        !refreshed.lastScanError) ||
                        (next === 1 &&
                          olderFailure === read().failure &&
                          baseline &&
                          completed.lastScanCompletedAt !== null &&
                          (baseline.lastScanCompletedAt === null ||
                            completed.lastScanCompletedAt > baseline.lastScanCompletedAt)))
                    ) {
                      updateFailure(view, { refresh: false })
                    }
                  }
                }
                updateFailure(view, { read: false })
              }
            } catch (error) {
              if (current.abandoned) {
                break
              }
              updateFailure(view, { read: true, ...(next === 2 ? { refresh: true } : {}) })
              if (pending !== 2) {
                stopLoading(view)
              }
              if (current.readOnFailure) {
                queueIntent(0)
              }
              console.error(`Failed to fetch ${config.name} usage:`, error)
            }
            next = current.abandoned ? null : pending
          }
          if (operation === current) {
            operation = null
          }
        })
        .finally(() => {
          unsubscribe?.()
          if (operation === current) {
            operation = null
          }
        })
      return current.promise
    }
    const fetchUsage = (opts?: { forceRefresh?: boolean }): Promise<void> =>
      request(opts?.forceRefresh ? 2 : 1)
    const observeUsage = (): (() => void) => {
      const target = get().statsHost
      const view = get().statsHostEpoch
      const unsubscribe = config.getApi(target).onConnectionChanged?.((connected, detail) => {
        if (detail?.initial) {
          updateFailure(view, { terminal: detail.unavailable === true })
          return
        }
        if (detail?.unavailable) {
          updateFailure(view, { terminal: true })
          return
        }
        if (connected) {
          updateFailure(view, { terminal: false })
          if (view === shownView()) {
            void request(0, true)
          }
        } else {
          stopLoading(view)
        }
      })
      void fetchUsage()
      return () => unsubscribe?.()
    }

    const setEnabled = async (enabled: boolean): Promise<void> => {
      const target = get().statsHost
      const view = get().statsHostEpoch
      try {
        const nextScanState: T['snapshot']['scanState'] | undefined = await config
          .getApi(target)
          .setEnabled({ enabled })
        if (!nextScanState) {
          return
        }
        updateFailure(
          view,
          enabled
            ? { setting: false, read: false, terminal: false }
            : { setting: false, read: false, terminal: false, refresh: false }
        )
        update(view, {
          scanState: enabled
            ? {
                ...nextScanState,
                isScanning: true,
                lastScanCompletedAt: null,
                lastScanError: null
              }
            : nextScanState,
          summary: null,
          daily: [],
          modelBreakdown: [],
          projectBreakdown: [],
          recentSessions: []
        })
        if (enabled && view === shownView()) {
          await fetchUsage({ forceRefresh: true })
        }
      } catch (error) {
        updateFailure(view, { setting: true })
        stopLoading(view)
        console.error(`Failed to update ${config.name} usage setting:`, error)
      }
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The configured prefix/name maps the declared data and action keys for this provider.
    return {
      ...createUsagePatch(
        config.prefix,
        createInitialUsageData<T>(config.initialScope, config.initialRange)
      ),
      [`set${config.name}UsageEnabled`]: setEnabled,
      [`set${config.name}UsageScope`]: async (scope: T['scope']) => {
        update(shownView(), { scope })
        await fetchUsage()
      },
      [`set${config.name}UsageRange`]: async (range: T['range']) => {
        update(shownView(), { range })
        await fetchUsage()
      },
      [`fetch${config.name}Usage`]: fetchUsage,
      [`observe${config.name}Usage`]: observeUsage,
      [`enable${config.name}Usage`]: () => setEnabled(true),
      [`refresh${config.name}Usage`]: () => fetchUsage({ forceRefresh: true })
    } as ProviderUsageSlice<Prefix, Name, T>
  }
}
