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
import type { AppState } from '../types'

type UsageSnapshot = {
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

type UsageShape<Scope extends string, Range extends string, Snapshot extends UsageSnapshot> = {
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
  }) => Promise<T['snapshot']>
}

type ProviderUsageSlice<
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

function createUsageProviderSlice<
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

    const fetchUsage = async (opts?: { forceRefresh?: boolean }): Promise<void> => {
      try {
        const api = config.getApi()
        const scanState = (await api.getScanState()) as T['snapshot']['scanState'] | undefined
        // Desktop-only usage APIs resolve undefined in paired web clients.
        if (!scanState) {
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

type ClaudeUsageShape = UsageShape<ClaudeUsageScope, ClaudeUsageRange, ClaudeUsageSnapshot>
type CodexUsageShape = UsageShape<CodexUsageScope, CodexUsageRange, CodexUsageSnapshot>
type OpenCodeUsageShape = UsageShape<OpenCodeUsageScope, OpenCodeUsageRange, OpenCodeUsageSnapshot>

export type ClaudeUsageSlice = ProviderUsageSlice<'claude', 'Claude', ClaudeUsageShape>
export type CodexUsageSlice = ProviderUsageSlice<'codex', 'Codex', CodexUsageShape>
export type OpenCodeUsageSlice = ProviderUsageSlice<'openCode', 'OpenCode', OpenCodeUsageShape>

export const createClaudeUsageSlice = createUsageProviderSlice<
  'claude',
  'Claude',
  ClaudeUsageShape
>({
  prefix: 'claude',
  name: 'Claude',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.claudeUsage,
  hasCachedData: (state) => state.hasAnyClaudeData
})

export const createCodexUsageSlice = createUsageProviderSlice<'codex', 'Codex', CodexUsageShape>({
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
  OpenCodeUsageShape
>({
  prefix: 'openCode',
  name: 'OpenCode',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.openCodeUsage,
  hasCachedData: (state) => state.hasAnyOpenCodeData
})
