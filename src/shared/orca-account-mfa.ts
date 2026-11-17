// The signed-in person's own two-factor state for their Orca account. The identity provider owns
// the factor; Orca only reads whether one is set and where to manage it.
export type OrcaAccountMfa = {
  mfa: 'on' | 'off'
  /** Opens the account's security page in the browser. Checked in main: Orca Cloud's own origin. */
  setupUrl: string
}

export type OrcaAccountMfaResult =
  | ({ status: 'ok' } & OrcaAccountMfa)
  /** `unsupported`: this Orca Cloud deployment (or local dev auth) has no MFA status. */
  | { status: 'unconfigured' | 'reconnect-required' | 'unsupported' }
  | { status: 'failed'; error: string }

/**
 * A team member's two-factor state as owners and admins see it. Absent for everyone else, and
 * for a member the provider said nothing about. 'pending': a team policy requires it by the
 * member's `mfaDeadline` and they have not set it up.
 */
// 'sso': the team's single sign-on is live and the member signs in through it.
export type OrcaOrgMemberMfa = 'on' | 'off' | 'pending' | 'sso'

/** The two-factor fields of a team member (OrcaOrgMember in orca-profiles.ts). */
export type OrcaOrgMemberMfaFields = {
  mfa?: OrcaOrgMemberMfa
  /** Epoch ms the member must have MFA by; only with `mfa: 'pending'`. */
  mfaDeadline?: number
}
