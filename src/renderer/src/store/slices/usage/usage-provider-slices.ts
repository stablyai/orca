import { createUsageProviderSlice } from './usage-provider-slice'
import type {
  ClaudeUsageTypes,
  CodexUsageTypes,
  OpenCodeUsageTypes,
  MuseUsageTypes,
  MistralVibeUsageTypes
} from './usage-provider-slice-contract'

export type {
  ClaudeUsageSlice,
  CodexUsageSlice,
  OpenCodeUsageSlice,
  MuseUsageSlice,
  MistralVibeUsageSlice
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

export const createMistralVibeUsageSlice = createUsageProviderSlice<
  'mistralVibe',
  'MistralVibe',
  MistralVibeUsageTypes
>({
  prefix: 'mistralVibe',
  name: 'MistralVibe',
  initialScope: 'orca',
  initialRange: '30d',
  getApi: () => window.api.mistralVibeUsage,
  hasCachedData: (state) => state.hasAnyMistralVibeData
})
