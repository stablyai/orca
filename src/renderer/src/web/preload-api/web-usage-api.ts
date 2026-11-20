import type { PreloadApi } from '../../../../preload/api-types'
import type {
  UsageProviderApi,
  UsageProviderSnapshot
} from '../../../../preload/api/agent-usage/agent-usage-api'
import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageSnapshot
} from '../../../../shared/agent-usage/analytics/claude-usage-types'
import type {
  CodexUsageBreakdownKind,
  CodexUsageSnapshot
} from '../../../../shared/agent-usage/analytics/codex-usage-types'
import type {
  MuseUsageBreakdownKind,
  MuseUsageSnapshot
} from '../../../../shared/agent-usage/analytics/muse-usage-types'
import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageSnapshot
} from '../../../../shared/agent-usage/analytics/opencode-usage-types'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'

type RuntimeUsageProvider = 'claude' | 'codex' | 'opencode' | 'muse'

function createUsageProviderApi<Snapshot extends UsageProviderSnapshot, BreakdownKind>(
  provider: RuntimeUsageProvider
): UsageProviderApi<Snapshot, BreakdownKind> {
  return {
    getScanState: () =>
      callRuntimeResult<Snapshot['scanState']>('usage.getScanState', { provider }),
    setEnabled: (args) =>
      callRuntimeResult<Snapshot['scanState']>('usage.setEnabled', { provider, ...args }),
    refresh: (args) =>
      callRuntimeResult<Snapshot['scanState']>('usage.refresh', { provider, ...args }),
    getSnapshot: (args) => callRuntimeResult<Snapshot>('usage.getSnapshot', { provider, ...args }),
    getSummary: (args) =>
      callRuntimeResult<Snapshot['summary']>('usage.getSummary', { provider, ...args }),
    getDaily: (args) =>
      callRuntimeResult<Snapshot['daily']>('usage.getDaily', { provider, ...args }),
    getBreakdown: (args) =>
      callRuntimeResult<Snapshot['modelBreakdown']>('usage.getBreakdown', { provider, ...args }),
    getRecentSessions: (args) =>
      callRuntimeResult<Snapshot['recentSessions']>('usage.getRecentSessions', {
        provider,
        ...args
      })
  }
}

export function createClaudeUsageApi(): PreloadApi['claudeUsage'] {
  return createUsageProviderApi<ClaudeUsageSnapshot, ClaudeUsageBreakdownKind>('claude')
}

export function createCodexUsageApi(): PreloadApi['codexUsage'] {
  return createUsageProviderApi<CodexUsageSnapshot, CodexUsageBreakdownKind>('codex')
}

export function createOpenCodeUsageApi(): PreloadApi['openCodeUsage'] {
  return createUsageProviderApi<OpenCodeUsageSnapshot, OpenCodeUsageBreakdownKind>('opencode')
}

export function createMuseUsageApi(): PreloadApi['museUsage'] {
  return createUsageProviderApi<MuseUsageSnapshot, MuseUsageBreakdownKind>('muse')
}
