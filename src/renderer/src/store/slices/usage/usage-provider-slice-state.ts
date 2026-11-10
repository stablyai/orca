import type { AppState } from '../../types'
import type { UsageSnapshot, UsageProviderTypes } from './usage-provider-types'
import type { UsageData } from './usage-provider-slice-contract'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: AppState contains each configured provider field; the prefix is fixed by the slice factory.
  const values = state as unknown as Record<string, unknown>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixed field list maps the configured provider keys back to their data fields.
  return Object.fromEntries(
    usageDataFields.map((field) => [field, values[usageDataKey(prefix, field)]])
  ) as UsageData<T>
}

export function createUsagePatch<T extends UsageProviderTypes<string, string, UsageSnapshot>>(
  prefix: string,
  patch: Partial<UsageData<T>>
): Partial<AppState> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixed field list maps the configured provider keys back to their data fields.
  return Object.fromEntries(
    usageDataFields
      .filter((field) => field in patch)
      .map((field) => [usageDataKey(prefix, field), patch[field]])
  ) as Partial<AppState>
}

export function createInitialUsageData<T extends UsageProviderTypes<string, string, UsageSnapshot>>(
  scope: T['scope'],
  range: T['range']
): UsageData<T> {
  return {
    scope,
    range,
    scanState: null,
    summary: null,
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
}
