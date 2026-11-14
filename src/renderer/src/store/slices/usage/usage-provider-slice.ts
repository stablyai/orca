import type { StateCreator } from 'zustand'
import type {
  UsageData,
  UsageApi,
  ProviderUsageSlice,
  UsageProviderConfig
} from './usage-provider-slice-contract'
import type { AppState } from '../../types'

import type { UsageSnapshot, UsageProviderTypes, UsageFailure } from './usage-provider-types'

import {
  mergeUsageFailure,
  readUsageData,
  createUsagePatch,
  createInitialUsageData
} from './usage-provider-slice-state'

export function createUsageProviderSlice<
  Prefix extends string,
  Name extends string,
  T extends UsageProviderTypes<string, string, UsageSnapshot>
>(
  config: UsageProviderConfig<Prefix, Name, T>
): StateCreator<AppState, [], [], ProviderUsageSlice<Prefix, Name, T>> {
  return (set, get) => {
    const update = (patch: Partial<UsageData<T>>): void =>
      set(createUsagePatch(config.prefix, patch))
    const read = (): UsageData<T> => readUsageData<T>(get(), config.prefix)

    const updateFailure = (patch: Partial<UsageFailure>): void => {
      const previous = read().failure
      const failure = mergeUsageFailure(previous, patch)
      if (failure !== previous) {
        update({ failure })
      }
    }

    const stopLoading = (): void => {
      const state = read().scanState
      if (state?.isScanning) {
        update({ scanState: { ...state, isScanning: false } })
      }
    }

    type Intent = 0 | 1 | 2
    type Operation = {
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
    const markLoading = (): void => {
      const state = read().scanState
      if (state?.enabled) {
        update({ scanState: { ...state, isScanning: true } })
      }
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
          update({ scanState: { ...snapshot.scanState, isScanning: true, lastScanError: null } })
        } else {
          update({
            ...snapshot,
            scanState: loading ? { ...snapshot.scanState, isScanning: true } : snapshot.scanState
          })
        }
        return snapshot.scanState
      }
      return undefined
    }
    const request = (intent: Intent, recovery = false): Promise<void> => {
      if (intent === 2) {
        markLoading()
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
        intent,
        phase: 'reading',
        disconnected: false,
        readOnFailure: false,
        promise: Promise.resolve()
      }
      operation = current
      const unsubscribe = config.getApi()?.onConnectionChanged?.((connected, detail) => {
        if (detail?.initial || detail?.unavailable) {
          return
        }
        if (!connected && operation === current) {
          if (current.intent === 2 || pending === 2) {
            updateFailure({ refresh: true })
          }
          current.disconnected = true
          current.readOnFailure = false
          pending = null
          stopLoading()
        }
      })
      // Publish the operation before the first port handshake can notify mounted readers.
      current.promise = Promise.resolve()
        .then(async () => {
          let next: Intent | null = intent
          while (next !== null) {
            current.intent = next
            current.phase = 'reading'
            current.disconnected = false
            current.readOnFailure = false
            pending = null
            try {
              const api = config.getApi()
              const state = await api.getScanState(next === 0 ? 'recovery' : undefined)
              if (current.disconnected) {
                throw new Error('Usage disconnected.')
              }
              if (state) {
                update({
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
                      updateFailure({ refresh: false })
                    }
                  }
                }
                updateFailure({ read: false })
              }
            } catch (error) {
              updateFailure({ read: true, ...(next === 2 ? { refresh: true } : {}) })
              if (pending !== 2) {
                stopLoading()
              }
              if (current.readOnFailure) {
                queueIntent(0)
              }
              console.error(`Failed to fetch ${config.name} usage:`, error)
            }
            next = pending
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
      const unsubscribe = config.getApi()?.onConnectionChanged?.((connected, detail) => {
        if (detail?.initial) {
          updateFailure({ terminal: detail.unavailable === true })
          return
        }
        if (detail?.unavailable) {
          updateFailure({ terminal: true })
          return
        }
        if (connected) {
          updateFailure({ terminal: false })
          void request(0, true)
        } else {
          stopLoading()
        }
      })
      void fetchUsage()
      return () => unsubscribe?.()
    }

    const setEnabled = async (enabled: boolean): Promise<void> => {
      try {
        const nextScanState = (await config.getApi().setEnabled({ enabled })) as
          | T['snapshot']['scanState']
          | undefined
        if (!nextScanState) {
          return
        }
        updateFailure(
          enabled
            ? { setting: false, read: false, terminal: false }
            : { setting: false, read: false, terminal: false, refresh: false }
        )
        update({
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
        if (enabled) {
          await fetchUsage({ forceRefresh: true })
        }
      } catch (error) {
        updateFailure({ setting: true })
        stopLoading()
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
        update({ scope })
        await fetchUsage()
      },
      [`set${config.name}UsageRange`]: async (range: T['range']) => {
        update({ range })
        await fetchUsage()
      },
      [`fetch${config.name}Usage`]: fetchUsage,
      [`observe${config.name}Usage`]: observeUsage,
      [`enable${config.name}Usage`]: () => setEnabled(true),
      [`refresh${config.name}Usage`]: () => fetchUsage({ forceRefresh: true })
    } as ProviderUsageSlice<Prefix, Name, T>
  }
}
