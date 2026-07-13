import type { UsageHourlyPoint } from './provider-usage-trends-model'

export type UsageTrendProvider = 'claude' | 'codex' | 'openCode' | 'gemini' | 'kimi'
export type HourlyQuery = { days: number } | { startDay: string; endDay: string }
export type TrendsScanState = {
  enabled: boolean
  lastScanError: string | null
}
export type TrendsResult = {
  scanState: TrendsScanState
  points: UsageHourlyPoint[]
}

function toClaudePoint(point: {
  day: string
  hour: number
  turnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}): UsageHourlyPoint {
  const totalTokens =
    point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens
  return {
    ...point,
    eventCount: point.turnCount,
    reasoningOutputTokens: 0,
    toolTokens: 0,
    totalTokens
  }
}

function toProviderPoint(point: {
  day: string
  hour: number
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  cacheWriteTokens?: number
  toolTokens?: number
  totalTokens: number
}): UsageHourlyPoint {
  return {
    ...point,
    cacheReadTokens: point.cachedInputTokens,
    cacheWriteTokens: point.cacheWriteTokens ?? 0,
    toolTokens: point.toolTokens ?? 0
  }
}

export const PROVIDER_TRENDS_SOURCES: Record<
  UsageTrendProvider,
  {
    displayName: string
    load: (query: HourlyQuery) => Promise<TrendsResult>
    enable: () => Promise<TrendsScanState>
    extraRows: 'claude' | 'reasoning' | 'gemini' | 'kimi'
  }
> = {
  claude: {
    displayName: 'Claude Code',
    load: async (query) => {
      const result = await window.api.claudeUsage.getHourly(query)
      return {
        scanState: result.scanState,
        points: result.points.map(toClaudePoint)
      }
    },
    enable: () => window.api.claudeUsage.setEnabled({ enabled: true }),
    extraRows: 'claude'
  },
  codex: {
    displayName: 'Codex',
    load: async (query) => {
      const result = await window.api.codexUsage.getHourly(query)
      return {
        scanState: result.scanState,
        points: result.points.map(toProviderPoint)
      }
    },
    enable: () => window.api.codexUsage.setEnabled({ enabled: true }),
    extraRows: 'reasoning'
  },
  openCode: {
    displayName: 'OpenCode',
    load: async (query) => {
      const result = await window.api.openCodeUsage.getHourly(query)
      return {
        scanState: result.scanState,
        points: result.points.map(toProviderPoint)
      }
    },
    enable: () => window.api.openCodeUsage.setEnabled({ enabled: true }),
    extraRows: 'reasoning'
  },
  gemini: {
    displayName: 'Gemini CLI',
    load: async (query) => {
      const result = await window.api.geminiUsage.getHourly(query)
      return {
        scanState: result.scanState,
        points: result.points.map(toProviderPoint)
      }
    },
    enable: () => window.api.geminiUsage.setEnabled({ enabled: true }),
    extraRows: 'gemini'
  },
  kimi: {
    displayName: 'Kimi Code',
    load: async (query) => {
      const result = await window.api.kimiUsage.getHourly(query)
      return {
        scanState: result.scanState,
        points: result.points.map(toProviderPoint)
      }
    },
    enable: () => window.api.kimiUsage.setEnabled({ enabled: true }),
    extraRows: 'kimi'
  }
}

export function getTrendsStorageKey(provider: UsageTrendProvider, preference: string): string {
  return `orca-status-bar-${provider}-trends-${preference}`
}

export function readStoredTrendValue<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  try {
    const stored = window.localStorage.getItem(key)
    return allowed.includes(stored as T) ? (stored as T) : fallback
  } catch {
    return fallback
  }
}

export function readStoredTrendString(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

export function storeTrendValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Why: trends preferences are cosmetic; storage failures must not break the popover.
  }
}
