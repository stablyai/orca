// A team's "require MFA" policy (Enterprise). The auth service owns it; the desktop reads the
// deadline and the person's own state for the banner and the blocked screen, and owners and
// admins set it from Settings, Enterprise.

/** Enforce now, or after a grace period in days. Mirrors the server's fixed choices. */
export const ORCA_TEAM_MFA_GRACE_CHOICES = ['now', 7, 14, 30] as const
export type OrcaTeamMfaGrace = (typeof ORCA_TEAM_MFA_GRACE_CHOICES)[number]

/**
 * The person's own state in this team:
 * - `pending`: the team requires MFA, they have none, the deadline has not passed.
 * - `blocked`: the deadline passed; the team's workspaces and settings are closed to them.
 * - `unknown`: the identity provider did not say; never treated as blocked.
 */
export type OrcaTeamMfaSelfState = 'on' | 'off' | 'pending' | 'blocked' | 'unknown'

export type OrcaTeamMfaPolicy = {
  /** Null when the team has no policy in force. */
  policy: { enforceAt: number; setAt: number } | null
  self: OrcaTeamMfaSelfState
  /** The account's security page, on Orca Cloud's own origin (checked in main). */
  setupUrl: string
  /** Owners and admins only. */
  manage?: {
    /** The team's plan includes MFA enforcement. */
    available: boolean
    pendingMembers: number
    /** A stored policy the plan no longer covers: it enforces nothing. */
    inactiveEnforceAt?: number
  }
}

export type OrcaTeamMfaPendingMember = {
  userId: string | null
  email: string
  displayName?: string
  mfa: 'pending' | 'blocked' | 'off'
}

type Unavailable =
  | { status: 'unconfigured' | 'reconnect-required' | 'unsupported' | 'forbidden' | 'rate-limited' }
  | { status: 'failed'; error: string }

export type OrcaTeamMfaPolicyResult = ({ status: 'ok' } & OrcaTeamMfaPolicy) | Unavailable

export type OrcaTeamMfaPolicySetResult =
  | { status: 'ok'; policy: { enforceAt: number; setAt: number } | null; pendingMembers: number }
  /** The person changing the policy has no MFA themselves; the policy read has the setup link. */
  | { status: 'actor-needs-mfa' }
  /** The team's plan does not include MFA enforcement. */
  | { status: 'not-entitled' }
  | Unavailable

export type OrcaTeamMfaPendingResult =
  | { status: 'ok'; members: OrcaTeamMfaPendingMember[] }
  | Unavailable

export type OrcaTeamMfaRemindResult =
  /** `delivery: 'log'` means the server recorded the reminder but sent no email. */
  | { status: 'ok'; recipients: number; delivery: 'log' | 'test-inbox' | 'unknown' }
  | { status: 'no-policy' | 'not-found' }
  | Unavailable

export type OrcaTeamMfaPolicyArgs = { orgId: string }
export type OrcaTeamMfaPolicySetArgs = { orgId: string; enforce: OrcaTeamMfaGrace | 'off' }
export type OrcaTeamMfaRemindArgs = { orgId: string; userId?: string }
