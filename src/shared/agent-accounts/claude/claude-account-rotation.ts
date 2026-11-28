/** 'prefer': preferred accounts, then lowest weekly use. 'reset': the account whose weekly limit resets soonest. */
export type ClaudeAccountRotationOrder = 'prefer' | 'reset'

/** One Claude account's own choices; a null limit uses the shared one. */
export type ClaudeAccountRotationAccountSettings = {
  /** False takes the account out: Orca never switches to it or away from it. */
  enabled: boolean
  fiveHourPercent: number | null
  weeklyPercent: number | null
}

export type ClaudeAccountRotationSettings = {
  enabled: boolean
  fiveHourPercent: number
  weeklyPercent: number
  order: ClaudeAccountRotationOrder
  /** Claude account uuids (or their prefixes), highest priority first; unlisted ones come last. */
  preferredAccounts: string[]
  /** Keyed by the first 8 characters of the Claude account uuid. */
  accounts: Record<string, ClaudeAccountRotationAccountSettings>
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
  preferredAccounts: [],
  accounts: {}
}

function clampPercent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(1, Math.round(value)))
    : fallback
}

function optionalPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clampPercent(value, 0) : null
}

function resolveAccounts(value: unknown): Record<string, ClaudeAccountRotationAccountSettings> {
  const out: Record<string, ClaudeAccountRotationAccountSettings> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return out
  }
  for (const [account, entry] of Object.entries(value)) {
    if (account === '' || typeof entry !== 'object' || entry === null) {
      continue
    }
    const saved: Record<string, unknown> = { ...entry }
    out[account.slice(0, 8)] = {
      enabled: saved.enabled !== false,
      fiveHourPercent: optionalPercent(saved.fiveHourPercent),
      weeklyPercent: optionalPercent(saved.weeklyPercent)
    }
  }
  return out
}

/** The choices that apply to one Claude account: its own, or the shared ones. */
export function rotationAccountSettings(
  settings: ClaudeAccountRotationSettings,
  account: string | null
): { enabled: boolean; fiveHourPercent: number; weeklyPercent: number } {
  const own = account ? settings.accounts[account.slice(0, 8)] : undefined
  return {
    enabled: own?.enabled !== false,
    fiveHourPercent: own?.fiveHourPercent ?? settings.fiveHourPercent,
    weeklyPercent: own?.weeklyPercent ?? settings.weeklyPercent
  }
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
      : [],
    accounts: resolveAccounts(saved.accounts)
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
  /** The pending switch left a folder with no login or a third account; see the journal. */
  switchNeedsRepair: boolean
}
