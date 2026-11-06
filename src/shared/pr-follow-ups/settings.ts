export const PR_FOLLOW_UPS_CAPABILITY = 'pr-followups.v1' as const

// Keep saved words intact so older clients cannot erase choices made by newer ones.
export type PrFollowUpsSettings = {
  enabled?: boolean
  events?: Record<string, string | undefined>
  includeBotComments?: boolean
  maxAutoRunsPerPr?: number
}

export type PrFollowUpsGlobalSettings = { prFollowUps?: PrFollowUpsSettings }

export type PrFollowUpsPatch = {
  path: 'enabled' | 'events.ciFailed' | 'maxAutoRunsPerPr'
  value: boolean | string | number | null
}

export function patchPrFollowUps(
  raw: PrFollowUpsSettings | undefined,
  { path, value }: PrFollowUpsPatch
): PrFollowUpsSettings {
  const next = { ...raw }
  if (path === 'events.ciFailed') {
    next.events = { ...raw?.events }
    if (value === null) {
      delete next.events.ciFailed
    } else if (typeof value === 'string') {
      next.events.ciFailed = value
    } else {
      throw new Error('Invalid follow-up action')
    }
  } else if (path === 'enabled') {
    if (value === null) {
      delete next.enabled
    } else if (typeof value === 'boolean') {
      next.enabled = value
    } else {
      throw new Error('Invalid follow-up switch')
    }
  } else {
    if (value === null) {
      delete next.maxAutoRunsPerPr
    } else if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3) {
      next.maxAutoRunsPerPr = value
    } else {
      throw new Error('The automatic run limit must be between 1 and 3')
    }
  }
  return next
}

export function resolvePrFollowUps(
  global: PrFollowUpsSettings | undefined,
  repo?: PrFollowUpsSettings
): { enabled: boolean; ciFailed: 'new-agent' | 'off'; maxAutoRunsPerPr: number } {
  const action = repo?.events?.ciFailed ?? global?.events?.ciFailed
  const cap = repo?.maxAutoRunsPerPr ?? global?.maxAutoRunsPerPr ?? 3
  return {
    enabled: (repo?.enabled ?? global?.enabled) === true,
    ciFailed: action === 'new-agent' ? 'new-agent' : 'off',
    maxAutoRunsPerPr: Number.isInteger(cap) && cap >= 1 && cap <= 3 ? cap : 3
  }
}
