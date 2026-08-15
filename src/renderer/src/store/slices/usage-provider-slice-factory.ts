import type { StateCreator } from 'zustand'
import type { CodexUsageAccountFilter } from '../../../../shared/codex-usage-types'
import type { AppState } from '../types'

export type UsageSnapshot = {
  scanState: {
    enabled: boolean
    isScanning: boolean
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
  summary: object
  daily: object[]
  modelBreakdown: object[]
  projectBreakdown: object[]
  recentSessions: object[]
}

export type UsageShape<
  Scope extends string,
  Range extends string,
  Snapshot extends UsageSnapshot
> = {
  scope: Scope
  range: Range
  snapshot: Snapshot
}

type UsageData<T extends UsageShape<string, string, UsageSnapshot>> = {
  scope: T['scope']
  range: T['range']
  scanState: T['snapshot']['scanState'] | null
  summary: T['snapshot']['summary'] | null
  daily: T['snapshot']['daily']
  modelBreakdown: T['snapshot']['modelBreakdown']
  projectBreakdown: T['snapshot']['projectBreakdown']
  recentSessions: T['snapshot']['recentSessions']
}

type UsageApi<T extends UsageShape<string, string, UsageSnapshot>> = {
  getScanState: () => Promise<T['snapshot']['scanState']>
  setEnabled: (args: { enabled: boolean }) => Promise<T['snapshot']['scanState']>
  refresh: (args?: { force?: boolean }) => Promise<T['snapshot']['scanState']>
  getSnapshot: (args: {
    scope: T['scope']
    range: T['range']
    limit?: number
    accountFilter?: CodexUsageAccountFilter
  }) => Promise<T['snapshot']>
}

export type ProviderUsageSlice<
  Prefix extends string,
  Name extends string,
  T extends UsageShape<string, string, UsageSnapshot>
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
  T extends UsageShape<string, string, UsageSnapshot>
> = {
  prefix: Prefix
  name: Name
  initialScope: T['scope']
  initialRange: T['range']
  getApi: () => UsageApi<T>
  hasCachedData: (scanState: T['snapshot']['scanState']) => boolean
  getExtraSnapshotArgs?: (state: AppState) => Record<string, unknown>
  mapSnapshotExtras?: (snapshot: T['snapshot']) => Partial<AppState>
  /** Resets whatever `mapSnapshotExtras` derives, without a snapshot to read. */
  clearSnapshotExtras?: () => Partial<AppState>
}

const usageDataFields = [
  'scope',
  'range',
  'scanState',
  'summary',
  'daily',
  'modelBreakdown',
  'projectBreakdown',
  'recentSessions'
] as const satisfies readonly (keyof UsageData<UsageShape<string, string, UsageSnapshot>>)[]

function usageDataKey(prefix: string, field: string): string {
  return `${prefix}Usage${field[0].toUpperCase()}${field.slice(1)}`
}

function readUsageData<T extends UsageShape<string, string, UsageSnapshot>>(
  state: AppState,
  prefix: string
): UsageData<T> {
  const values = state as unknown as Record<string, unknown>
  return Object.fromEntries(
    usageDataFields.map((field) => [field, values[usageDataKey(prefix, field)]])
  ) as UsageData<T>
}

function createUsagePatch<T extends UsageShape<string, string, UsageSnapshot>>(
  prefix: string,
  patch: Partial<UsageData<T>>
): Partial<AppState> {
  return Object.fromEntries(
    usageDataFields
      .filter((field) => field in patch)
      .map((field) => [usageDataKey(prefix, field), patch[field]])
  ) as Partial<AppState>
}

export function createUsageProviderSlice<
  Prefix extends string,
  Name extends string,
  T extends UsageShape<string, string, UsageSnapshot>
>(
  config: UsageProviderConfig<Prefix, Name, T>
): StateCreator<AppState, [], [], ProviderUsageSlice<Prefix, Name, T>> {
  return (set, get) => {
    const update = (patch: Partial<UsageData<T>>): void =>
      set(createUsagePatch(config.prefix, patch))
    const read = (): UsageData<T> => readUsageData<T>(get(), config.prefix)
    let fetchGeneration = 0

    const fetchUsage = async (opts?: { forceRefresh?: boolean }): Promise<void> => {
      const generation = ++fetchGeneration
      try {
        const api = config.getApi()
        const scanState = (await api.getScanState()) as T['snapshot']['scanState'] | undefined
        // Desktop-only usage APIs resolve undefined in paired web clients.
        if (!scanState || generation !== fetchGeneration) {
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
          limit: 10,
          ...config.getExtraSnapshotArgs?.(get())
        })
        if (generation !== fetchGeneration) {
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
          if (config.mapSnapshotExtras) {
            set(config.mapSnapshotExtras(snapshot))
          }
        } else {
          update({ scanState: { ...scanState, isScanning: true, lastScanError: null } })
        }

        await api.refresh({ force: opts?.forceRefresh ?? false })
        if (generation !== fetchGeneration) {
          return
        }
        const refreshedSelection = read()
        const refreshedSnapshot = await api.getSnapshot({
          scope: refreshedSelection.scope,
          range: refreshedSelection.range,
          limit: 10,
          ...config.getExtraSnapshotArgs?.(get())
        })
        if (generation !== fetchGeneration) {
          return
        }
        update(refreshedSnapshot)
        if (config.mapSnapshotExtras) {
          set(config.mapSnapshotExtras(refreshedSnapshot))
        }
      } catch (error) {
        console.error(`Failed to fetch ${config.name} usage:`, error)
      }
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
        if (config.clearSnapshotExtras) {
          set(config.clearSnapshotExtras())
        }
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
