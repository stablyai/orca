import { createUsageProviderSlice } from './usage-provider-slice'
import { usageApiForHost } from './usage-host'
import { createUsagePatch } from './usage-provider-slice-state'
import type { AppState } from '../../types'
import type {
  ClaudeUsageTypes,
  CodexUsageTypes,
  OpenCodeUsageTypes,
  MuseUsageTypes
} from './usage-provider-slice-contract'

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
  getApi: (host) => usageApiForHost(host, 'claudeUsage'),
  hasCachedData: (state) => state.hasAnyClaudeData
})

export const createCodexUsageSlice = createUsageProviderSlice<'codex', 'Codex', CodexUsageTypes>({
  prefix: 'codex',
  name: 'Codex',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: (host) => usageApiForHost(host, 'codexUsage'),
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
  getApi: (host) => usageApiForHost(host, 'openCodeUsage'),
  hasCachedData: (state) => state.hasAnyOpenCodeData
})

export const createMuseUsageSlice = createUsageProviderSlice<'muse', 'Muse', MuseUsageTypes>({
  prefix: 'muse',
  name: 'Muse',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: (host) => usageApiForHost(host, 'museUsage'),
  hasCachedData: (state) => state.hasAnyMuseData
})

/** A host switch clears every provider's numbers, keeping the chosen scope and range. */
export function clearUsageProviderData(): Partial<AppState> {
  return Object.assign(
    {},
    ...(['claude', 'codex', 'openCode', 'muse'] as const).map((prefix) =>
      createUsagePatch(prefix, {
        failure: null,
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
