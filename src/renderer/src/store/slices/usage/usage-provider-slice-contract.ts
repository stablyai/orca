import type {
  BackendConnectionListener,
  BackendConnectionPurpose
} from '../../../../../shared/backend-service-contract'
import type {
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSnapshot
} from '../../../../../shared/claude-usage-types'
import type {
  CodexUsageRange,
  CodexUsageScope,
  CodexUsageSnapshot
} from '../../../../../shared/codex-usage-types'
import type {
  OpenCodeUsageRange,
  OpenCodeUsageScope,
  OpenCodeUsageSnapshot
} from '../../../../../shared/opencode-usage-types'
import type {
  MuseUsageRange,
  MuseUsageScope,
  MuseUsageSnapshot
} from '../../../../../shared/muse-usage-types'
import type { UsageSnapshot, UsageProviderTypes, UsageFailure } from './usage-provider-types'

export type UsageData<T extends UsageProviderTypes<string, string, UsageSnapshot>> = {
  failure: UsageFailure | null
  scope: T['scope']
  range: T['range']
  scanState: T['snapshot']['scanState'] | null
  summary: T['snapshot']['summary'] | null
  daily: T['snapshot']['daily']
  modelBreakdown: T['snapshot']['modelBreakdown']
  projectBreakdown: T['snapshot']['projectBreakdown']
  recentSessions: T['snapshot']['recentSessions']
}

export type UsageApi<T extends UsageProviderTypes<string, string, UsageSnapshot>> = {
  onConnectionChanged?: (listener: BackendConnectionListener) => () => void
  getScanState: (purpose?: BackendConnectionPurpose) => Promise<T['snapshot']['scanState']>
  setEnabled: (args: { enabled: boolean }) => Promise<T['snapshot']['scanState']>
  refresh: (args?: { force?: boolean }) => Promise<T['snapshot']['scanState']>
  getSnapshot: (
    args: {
      scope: T['scope']
      range: T['range']
      limit?: number
    },
    purpose?: BackendConnectionPurpose
  ) => Promise<T['snapshot']>
}

export type ProviderUsageSlice<
  Prefix extends string,
  Name extends string,
  T extends UsageProviderTypes<string, string, UsageSnapshot>
> = {
  [K in keyof UsageData<T> as `${Prefix}Usage${Capitalize<K & string>}`]: UsageData<T>[K]
} & Record<`set${Name}UsageEnabled`, (enabled: boolean) => Promise<void>> &
  Record<`set${Name}UsageScope`, (scope: T['scope']) => Promise<void>> &
  Record<`set${Name}UsageRange`, (range: T['range']) => Promise<void>> &
  Record<`fetch${Name}Usage`, (opts?: { forceRefresh?: boolean }) => Promise<void>> &
  Record<`observe${Name}Usage`, () => () => void> &
  Record<`enable${Name}Usage`, () => Promise<void>> &
  Record<`refresh${Name}Usage`, () => Promise<void>>

export type UsageProviderConfig<
  Prefix extends string,
  Name extends string,
  T extends UsageProviderTypes<string, string, UsageSnapshot>
> = {
  prefix: Prefix
  name: Name
  initialScope: T['scope']
  initialRange: T['range']
  getApi: () => UsageApi<T>
  hasCachedData: (scanState: T['snapshot']['scanState']) => boolean
}
export type ClaudeUsageTypes = UsageProviderTypes<
  ClaudeUsageScope,
  ClaudeUsageRange,
  ClaudeUsageSnapshot
>
export type CodexUsageTypes = UsageProviderTypes<
  CodexUsageScope,
  CodexUsageRange,
  CodexUsageSnapshot
>
export type OpenCodeUsageTypes = UsageProviderTypes<
  OpenCodeUsageScope,
  OpenCodeUsageRange,
  OpenCodeUsageSnapshot
>

export type MuseUsageTypes = UsageProviderTypes<MuseUsageScope, MuseUsageRange, MuseUsageSnapshot>

export type ClaudeUsageSlice = ProviderUsageSlice<'claude', 'Claude', ClaudeUsageTypes>
export type CodexUsageSlice = ProviderUsageSlice<'codex', 'Codex', CodexUsageTypes>
export type OpenCodeUsageSlice = ProviderUsageSlice<'openCode', 'OpenCode', OpenCodeUsageTypes>
export type MuseUsageSlice = ProviderUsageSlice<'muse', 'Muse', MuseUsageTypes>
