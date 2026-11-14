// A team's "require MFA" policy (Enterprise). The auth service owns it; the desktop reads the
// deadline and the person's own state for the banner and the blocked screen. Owners and admins
// set it in the web console.

/**
 * The person's own state in this team:
 * - `pending`: the team requires MFA, they have none, the deadline has not passed.
 * - `blocked`: the deadline passed; the team's workspaces and settings are closed to them.
 * - `unknown`: the identity provider did not say; never treated as blocked.
 * - `delegated`: the team's single sign-on is live and they sign in through it, so their second
 *   factor is their identity provider's and the policy does not apply to them.
 */
export type OrcaTeamMfaSelfState = 'on' | 'off' | 'pending' | 'blocked' | 'unknown' | 'delegated'

export type OrcaTeamMfaPolicy = {
  /** Null when the team has no policy in force. */
  policy: { enforceAt: number; setAt: number } | null
  self: OrcaTeamMfaSelfState
  /** The account's security page, on Orca Cloud's own origin (checked in main). */
  setupUrl: string
}

type Unavailable =
  | { status: 'unconfigured' | 'reconnect-required' | 'unsupported' | 'forbidden' | 'rate-limited' }
  | { status: 'failed'; error: string }

export type OrcaTeamMfaPolicyResult = ({ status: 'ok' } & OrcaTeamMfaPolicy) | Unavailable

export type OrcaTeamMfaPolicyArgs = { orgId: string }
