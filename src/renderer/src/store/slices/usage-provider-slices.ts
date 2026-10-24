import type { StateCreator } from 'zustand'
import type {
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSnapshot
} from '../../../../shared/claude-usage-types'
import type {
  CodexUsageRange,
  CodexUsageScope,
  CodexUsageSnapshot
} from '../../../../shared/codex-usage-types'
import type {
  OpenCodeUsageRange,
  OpenCodeUsageScope,
  OpenCodeUsageSnapshot
} from '../../../../shared/opencode-usage-types'
import type {
  MuseUsageRange,
  MuseUsageScope,
  MuseUsageSnapshot
} from '../../../../shared/muse-usage-types'
import type { AppState } from '../types'
import { runtimeTargetEnvironmentId } from '../../runtime/runtime-client-target'
import {
  createRuntimeUsageAnalyticsApi,
  type UsageAnalyticsApi,
  type UsageAnalyticsProvider
} from '../../runtime/runtime-usage-analytics-client'
import {
  createUsagePatch,
  readUsageData,
  type UsageData,
  type UsageProviderTypes,
  type UsageSnapshot
} from './usage-provider-state'

type UsageApi<T extends UsageProviderTypes<string, string, UsageSnapshot>> = UsageAnalyticsApi<
  T['snapshot']['scanState'],
  T['snapshot'],
  T['scope'],
  T['range']
>

type ProviderUsageSlice<
  Prefix extends string,
  Name extends string,
  T extends UsageProviderTypes<string, string, UsageSnapshot>
> = {
  [K in keyof UsageData<T> as `${Prefix}Usage${Capitalize<K & string>}`]: UsageData<T>[K]
} & Record<`set${Name}UsageEnabled`, (enabled: boolean) => Promise<void>> &
  Record<`set${Name}UsageScope`, (scope: T['scope']) => Promise<void>> &
  Record<`set${Name}UsageRange`, (range: T['range']) => Promise<void>> &
  Record<`fetch${Name}Usage`, (opts?: { forceRefresh?: boolean }) => Promise<void>> &
  Record<`enable${Name}Usage`, () => Promise<void>> &
  Record<`refresh${Name}Usage`, () => Promise<void>>

type UsageProviderConfig<
  Prefix extends string,
  Name extends string,
  T extends UsageProviderTypes<string, string, UsageSnapshot>
> = {
  prefix: Prefix
  name: Name
  provider: UsageAnalyticsProvider
  initialScope: T['scope']
  initialRange: T['range']
  getLocalApi: () => UsageApi<T>
  hasCachedData: (scanState: T['snapshot']['scanState']) => boolean
}

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
    // Why: a host switch mid-request must not land the old host's answer on the new one, so a
    // request writes only through the host-bound `update` returned here.
    const bindToCurrentHost = () => {
      const host = get().statsHost
      const hostId = runtimeTargetEnvironmentId(host)
      const api: UsageApi<T> =
        host.kind === 'environment'
          ? createRuntimeUsageAnalyticsApi(host, config.provider)
          : config.getLocalApi()
      const isCurrent = (): boolean => runtimeTargetEnvironmentId(get().statsHost) === hostId
      const updateIfCurrent = (patch: Partial<UsageData<T>>): void => {
        if (isCurrent()) {
          update(patch)
        }
      }
      return { api, update: updateIfCurrent, isCurrent }
    }

    const fetchUsage = async (opts?: { forceRefresh?: boolean }): Promise<void> => {
      try {
        const { api, update, isCurrent } = bindToCurrentHost()
        const scanState = (await api.getScanState()) as T['snapshot']['scanState'] | undefined
        // Desktop-only usage APIs resolve undefined in paired web clients.
        if (!scanState || !isCurrent()) {
          return
        }

        const current = read()
        const preserveLoading =
          opts?.forceRefresh === true &&
          current.scanState?.enabled === true &&
          current.summary === null
        update({
          scanState: preserveLoading
            ? {
                ...scanState,
                isScanning: true,
                lastScanCompletedAt: null,
                lastScanError: null
              }
            : scanState
        })
        if (!scanState.enabled) {
          return
        }

        const selection = read()
        const snapshot = await api.getSnapshot({
          scope: selection.scope,
          range: selection.range,
          limit: 10
        })
        if (!isCurrent()) {
          return
        }
        if (
          snapshot.scanState.lastScanCompletedAt !== null ||
          config.hasCachedData(snapshot.scanState)
        ) {
          update({
            ...snapshot,
            scanState:
              opts?.forceRefresh === true
                ? { ...snapshot.scanState, isScanning: true }
                : snapshot.scanState
          })
        } else {
          update({ scanState: { ...scanState, isScanning: true, lastScanError: null } })
        }

        await api.refresh({ force: opts?.forceRefresh ?? false })
        if (!isCurrent()) {
          return
        }
        const refreshedSelection = read()
        update(
          await api.getSnapshot({
            scope: refreshedSelection.scope,
            range: refreshedSelection.range,
            limit: 10
          })
        )
      } catch (error) {
        console.error(`Failed to fetch ${config.name} usage:`, error)
      }
    }

    const setEnabled = async (enabled: boolean): Promise<void> => {
      try {
        const { api, update } = bindToCurrentHost()
        const nextScanState: T['snapshot']['scanState'] | undefined = await api.setEnabled({
          enabled
        })
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
        console.error(`Failed to update ${config.name} usage setting:`, error)
      }
    }

    const initialData: UsageData<T> = {
      scope: config.initialScope,
      range: config.initialRange,
      scanState: null,
      summary: null,
      daily: [],
      modelBreakdown: [],
      projectBreakdown: [],
      recentSessions: []
    }

    return {
      ...createUsagePatch(config.prefix, initialData),
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
      [`enable${config.name}Usage`]: () => setEnabled(true),
      [`refresh${config.name}Usage`]: () => fetchUsage({ forceRefresh: true })
    } as ProviderUsageSlice<Prefix, Name, T>
  }
}

type ClaudeUsageTypes = UsageProviderTypes<ClaudeUsageScope, ClaudeUsageRange, ClaudeUsageSnapshot>
type CodexUsageTypes = UsageProviderTypes<CodexUsageScope, CodexUsageRange, CodexUsageSnapshot>
type OpenCodeUsageTypes = UsageProviderTypes<
  OpenCodeUsageScope,
  OpenCodeUsageRange,
  OpenCodeUsageSnapshot
>

type MuseUsageTypes = UsageProviderTypes<MuseUsageScope, MuseUsageRange, MuseUsageSnapshot>

export type ClaudeUsageSlice = ProviderUsageSlice<'claude', 'Claude', ClaudeUsageTypes>
export type CodexUsageSlice = ProviderUsageSlice<'codex', 'Codex', CodexUsageTypes>
export type OpenCodeUsageSlice = ProviderUsageSlice<'openCode', 'OpenCode', OpenCodeUsageTypes>
export type MuseUsageSlice = ProviderUsageSlice<'muse', 'Muse', MuseUsageTypes>

export const createClaudeUsageSlice = createUsageProviderSlice<
  'claude',
  'Claude',
  ClaudeUsageTypes
>({
  prefix: 'claude',
  name: 'Claude',
  provider: 'claude',
  initialScope: 'orca',
  initialRange: '30d',
  getLocalApi: () => window.api.claudeUsage,
  hasCachedData: (state) => state.hasAnyClaudeData
})

export const createCodexUsageSlice = createUsageProviderSlice<'codex', 'Codex', CodexUsageTypes>({
  prefix: 'codex',
  name: 'Codex',
  provider: 'codex',
  initialScope: 'orca',
  initialRange: '30d',
  getLocalApi: () => window.api.codexUsage,
  hasCachedData: (state) => state.hasAnyCodexData
})

export const createOpenCodeUsageSlice = createUsageProviderSlice<
  'openCode',
  'OpenCode',
  OpenCodeUsageTypes
>({
  prefix: 'openCode',
  name: 'OpenCode',
  provider: 'opencode',
  initialScope: 'orca',
  initialRange: '30d',
  getLocalApi: () => window.api.openCodeUsage,
  hasCachedData: (state) => state.hasAnyOpenCodeData
})

export const createMuseUsageSlice = createUsageProviderSlice<'muse', 'Muse', MuseUsageTypes>({
  prefix: 'muse',
  name: 'Muse',
  provider: 'muse',
  initialScope: 'orca',
  initialRange: '30d',
  getLocalApi: () => window.api.museUsage,
  hasCachedData: (state) => state.hasAnyMuseData
})
