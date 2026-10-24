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

export type UsageProviderTypes<
  Scope extends string,
  Range extends string,
  Snapshot extends UsageSnapshot
> = {
  scope: Scope
  range: Range
  snapshot: Snapshot
}

export type UsageData<T extends UsageProviderTypes<string, string, UsageSnapshot>> = {
  scope: T['scope']
  range: T['range']
  scanState: T['snapshot']['scanState'] | null
  summary: T['snapshot']['summary'] | null
  daily: T['snapshot']['daily']
  modelBreakdown: T['snapshot']['modelBreakdown']
  projectBreakdown: T['snapshot']['projectBreakdown']
  recentSessions: T['snapshot']['recentSessions']
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
] as const satisfies readonly (keyof UsageData<UsageProviderTypes<string, string, UsageSnapshot>>)[]

function usageDataKey(prefix: string, field: string): string {
  return `${prefix}Usage${field[0].toUpperCase()}${field.slice(1)}`
}

export function readUsageData<T extends UsageProviderTypes<string, string, UsageSnapshot>>(
  state: AppState,
  prefix: string
): UsageData<T> {
  const values = state as unknown as Record<string, unknown>
  return Object.fromEntries(
    usageDataFields.map((field) => [field, values[usageDataKey(prefix, field)]])
  ) as UsageData<T>
}

export function createUsagePatch<T extends UsageProviderTypes<string, string, UsageSnapshot>>(
  prefix: string,
  patch: Partial<UsageData<T>>
): Partial<AppState> {
  return Object.fromEntries(
    usageDataFields
      .filter((field) => field in patch)
      .map((field) => [usageDataKey(prefix, field), patch[field]])
  ) as Partial<AppState>
}

const USAGE_PROVIDER_PREFIXES = ['claude', 'codex', 'openCode', 'muse'] as const

/** Clears every provider's numbers, keeping each pane's scope and range choices. */
export function createUsageProviderResetPatch(): Partial<AppState> {
  return Object.assign(
    {},
    ...USAGE_PROVIDER_PREFIXES.map((prefix) =>
      createUsagePatch(prefix, {
        scanState: null,
        summary: null,
        daily: [],
        modelBreakdown: [],
        projectBreakdown: [],
        recentSessions: []
      })
    )
  )
}
