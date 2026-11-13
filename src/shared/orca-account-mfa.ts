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
