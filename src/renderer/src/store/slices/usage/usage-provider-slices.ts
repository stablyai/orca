import type { StateCreator } from 'zustand'
import type {
  ClaudeUsageTypes,
  CodexUsageTypes,
  OpenCodeUsageTypes,
  MuseUsageTypes,
  UsageData,
  UsageApi,
  ProviderUsageSlice,
  UsageProviderConfig
} from './usage-provider-slice-contract'
import type { AppState } from '../../types'

import type { UsageSnapshot, UsageProviderTypes } from './usage-provider-types'

import {
  readUsageData,
  createUsagePatch,
  createInitialUsageData
} from './usage-provider-slice-state'

function createUsageProviderSlice<
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
      loading: boolean
    ): Promise<void> => {
      while (!current.disconnected) {
        const { scope, range } = read()
        const snapshot = await api.getSnapshot({ scope, range, limit: 10 })
        if (current.disconnected) {
          return
        }
        if (scope !== read().scope || range !== read().range) {
          continue
        }
        if (
          loading &&
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
        return
      }
    }
    const request = (intent: Intent, recovery = false): Promise<void> => {
      if (intent > 0) {
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
      const unsubscribe = config.getApi()?.onConnectionChanged?.((connected) => {
        if (!connected && operation === current) {
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
              const state = await api.getScanState()
              if (current.disconnected) {
                throw new Error('Usage disconnected.')
              }
              if (state) {
                update({
                  scanState: next > 0 && state.enabled ? { ...state, isScanning: true } : state
                })
                if (state.enabled) {
                  await project(api, current, next > 0)
                  if (current.disconnected) {
                    throw new Error('Usage disconnected.')
                  }
                  if (next > 0) {
                    current.phase = 'refreshing'
                    await api.refresh({ force: next === 2 })
                    if (current.disconnected) {
                      throw new Error('Usage disconnected.')
                    }
                    current.phase = 'projecting'
                    await project(api, current, false)
                  }
                }
              }
            } catch (error) {
              stopLoading()
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
      const unsubscribe = config.getApi()?.onConnectionChanged?.((connected) => {
        if (connected) {
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

export type {
  ClaudeUsageSlice,
  CodexUsageSlice,
  OpenCodeUsageSlice,
  MuseUsageSlice
} from './usage-provider-slice-contract'

export const createClaudeUsageSlice = createUsageProviderSlice<
  'claude',
  'Claude',
  ClaudeUsageTypes
>({
  prefix: 'claude',
  name: 'Claude',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.claudeUsage,
  hasCachedData: (state) => state.hasAnyClaudeData
})

export const createCodexUsageSlice = createUsageProviderSlice<'codex', 'Codex', CodexUsageTypes>({
  prefix: 'codex',
  name: 'Codex',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.codexUsage,
  hasCachedData: (state) => state.hasAnyCodexData
})

export const createOpenCodeUsageSlice = createUsageProviderSlice<
  'openCode',
  'OpenCode',
  OpenCodeUsageTypes
>({
  prefix: 'openCode',
  name: 'OpenCode',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.openCodeUsage,
  hasCachedData: (state) => state.hasAnyOpenCodeData
})

export const createMuseUsageSlice = createUsageProviderSlice<'muse', 'Muse', MuseUsageTypes>({
  prefix: 'muse',
  name: 'Muse',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.museUsage,
  hasCachedData: (state) => state.hasAnyMuseData
})
