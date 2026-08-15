import type { StateCreator } from 'zustand'
import type {
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSnapshot
} from '../../../../shared/claude-usage-types'
import type {
  CodexUsageAccountFilter,
  CodexUsageAccountOption,
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
import {
  createUsageProviderSlice,
  type ProviderUsageSlice,
  type UsageShape
} from './usage-provider-slice-factory'

type ClaudeUsageShape = UsageShape<ClaudeUsageScope, ClaudeUsageRange, ClaudeUsageSnapshot>
type CodexUsageShape = UsageShape<CodexUsageScope, CodexUsageRange, CodexUsageSnapshot>
type OpenCodeUsageShape = UsageShape<OpenCodeUsageScope, OpenCodeUsageRange, OpenCodeUsageSnapshot>

export type ClaudeUsageSlice = ProviderUsageSlice<'claude', 'Claude', ClaudeUsageShape>
export type CodexUsageSlice = ProviderUsageSlice<'codex', 'Codex', CodexUsageShape> & {
  codexUsageAccountFilter: CodexUsageAccountFilter
  codexUsageAccountOptions: CodexUsageAccountOption[]
  setCodexUsageAccountFilter: (filter: CodexUsageAccountFilter) => Promise<void>
}
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

const createCodexUsageProviderSlice = createUsageProviderSlice<'codex', 'Codex', CodexUsageShape>({
  prefix: 'codex',
  name: 'Codex',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.codexUsage,
  hasCachedData: (state) => state.hasAnyCodexData,
  getExtraSnapshotArgs: (state) => ({ accountFilter: state.codexUsageAccountFilter }),
  mapSnapshotExtras: (snapshot) => ({
    codexUsageAccountOptions: snapshot.accountOptions ?? []
  }),
  clearSnapshotExtras: () => ({ codexUsageAccountOptions: [] })
})

export const createCodexUsageSlice: StateCreator<AppState, [], [], CodexUsageSlice> = (
  set,
  get,
  api
) => ({
  ...createCodexUsageProviderSlice(set, get, api),
  codexUsageAccountFilter: { kind: 'all' },
  codexUsageAccountOptions: [],
  setCodexUsageAccountFilter: async (filter) => {
    set({
      codexUsageAccountFilter: filter
    })
    await get().fetchCodexUsage()
  }
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
