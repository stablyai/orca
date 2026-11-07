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
import type {
  ZcodeUsageRange,
  ZcodeUsageScope,
  ZcodeUsageSnapshot
} from '../../../../shared/zcode-usage-types'
import {
  createUsageProviderSlice,
  type ProviderUsageSlice,
  type UsageProviderTypes
} from './usage-provider-slice'

type ClaudeUsageTypes = UsageProviderTypes<ClaudeUsageScope, ClaudeUsageRange, ClaudeUsageSnapshot>
type CodexUsageTypes = UsageProviderTypes<CodexUsageScope, CodexUsageRange, CodexUsageSnapshot>
type OpenCodeUsageTypes = UsageProviderTypes<
  OpenCodeUsageScope,
  OpenCodeUsageRange,
  OpenCodeUsageSnapshot
>

type MuseUsageTypes = UsageProviderTypes<MuseUsageScope, MuseUsageRange, MuseUsageSnapshot>

type ZcodeUsageTypes = UsageProviderTypes<ZcodeUsageScope, ZcodeUsageRange, ZcodeUsageSnapshot>

export type ClaudeUsageSlice = ProviderUsageSlice<'claude', 'Claude', ClaudeUsageTypes>
export type CodexUsageSlice = ProviderUsageSlice<'codex', 'Codex', CodexUsageTypes>
export type OpenCodeUsageSlice = ProviderUsageSlice<'openCode', 'OpenCode', OpenCodeUsageTypes>
export type MuseUsageSlice = ProviderUsageSlice<'muse', 'Muse', MuseUsageTypes>
export type ZcodeUsageSlice = ProviderUsageSlice<'zcode', 'Zcode', ZcodeUsageTypes>

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

export const createZcodeUsageSlice = createUsageProviderSlice<'zcode', 'Zcode', ZcodeUsageTypes>({
  prefix: 'zcode',
  name: 'Zcode',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.zcodeUsage,
  hasCachedData: (state) => state.hasAnyZcodeData
})
