/** 'prefer': preferred accounts, then lowest weekly use. 'reset': the account whose weekly limit resets soonest. */
export type ClaudeAccountRotationOrder = 'prefer' | 'reset'

export type ClaudeAccountRotationSettings = {
  enabled: boolean
  fiveHourPercent: number
  weeklyPercent: number
  order: ClaudeAccountRotationOrder
  /** Claude account uuids (or their prefixes), most preferred first. */
  preferredAccounts: string[]
}

export type ClaudeAccountRotationGlobalSettings = {
  /** Absent means off with the defaults below. */
  claudeAccountRotation?: Partial<ClaudeAccountRotationSettings>
}

export const CLAUDE_ACCOUNT_ROTATION_DEFAULTS: ClaudeAccountRotationSettings = {
  enabled: false,
  fiveHourPercent: 90,
  weeklyPercent: 97,
  order: 'prefer',
  preferredAccounts: []
}

function clampPercent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(1, Math.round(value)))
    : fallback
}

export function resolveClaudeAccountRotationSettings(
  settings: ClaudeAccountRotationGlobalSettings
): ClaudeAccountRotationSettings {
  const saved = settings.claudeAccountRotation ?? {}
  const defaults = CLAUDE_ACCOUNT_ROTATION_DEFAULTS
  return {
    enabled: saved.enabled === true,
    fiveHourPercent: clampPercent(saved.fiveHourPercent, defaults.fiveHourPercent),
    weeklyPercent: clampPercent(saved.weeklyPercent, defaults.weeklyPercent),
    order: saved.order === 'reset' ? 'reset' : 'prefer',
    preferredAccounts: Array.isArray(saved.preferredAccounts)
      ? saved.preferredAccounts.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
  }
}

/** Why the rotation is not acting right now; null while it runs. */
export type ClaudeAccountRotationPause =
  | 'off'
  | 'unsupported-platform'
  | 'external-rotator'
  | 'no-accounts'
  | null

export type ClaudeAccountRotationUsage = {
  fiveHourPercent: number
  weeklyPercent: number
  weeklyResetsAt: number | null
  checkedAt: number
}

export type ClaudeAccountRotationFolder = {
  /** The Orca account id that names this folder. */
  accountId: string
  /** First 8 characters of the Claude account uuid whose login the folder holds. */
  claudeAccount: string | null
  label: string | null
  selected: boolean
  /** Null until a check has counted them. */
  sessions: number | null
  /** 'resting': the access token expired and waits for a Claude session to refresh it. */
  login: 'none' | 'active' | 'resting' | 'unknown'
  usage: ClaudeAccountRotationUsage | null
  preferred: boolean
}

export type ClaudeAccountRotationLimit = { window: 'five-hour' | 'weekly'; percent: number }

export type ClaudeAccountRotationSwitch = {
  at: number
  accountId: string
  fromClaudeAccount: string | null
  toClaudeAccount: string | null
  fromLabel: string | null
  toLabel: string | null
  /** 'over': a limit was reached; 'prefer'/'reset': a return to a better account. */
  kind: 'over' | 'prefer' | 'reset'
  limits: ClaudeAccountRotationLimit[]
}

export type ClaudeAccountRotationStatus = {
  supported: boolean
  enabled: boolean
  pause: ClaudeAccountRotationPause
  /** claude_rotate.py is on (or mid-swap); Orca then reads and writes nothing. */
  externalRotatorActive: boolean
  settings: ClaudeAccountRotationSettings
  folders: ClaudeAccountRotationFolder[]
  lastSwitch: ClaudeAccountRotationSwitch | null
  /** The folder whose login a switch out of the selected folder would bring in. */
  nextCandidateAccountId: string | null
  /** Latest outcome of checking the selected folder, e.g. 'over_no_candidate'. */
  lastNote: string | null
  lastCheckedAt: number | null
  pendingSwitch: boolean
}
