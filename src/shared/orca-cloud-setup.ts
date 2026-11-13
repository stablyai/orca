// Orca Cloud setup session (NP-4 N1): one browser tab that chains sign-in, team, plan or trial,
// Checkout (only when needed) and the GitHub App install. The billing service owns the session;
// the desktop starts it and polls it while the composer's setup panel shows each step.

export const CLOUD_SETUP_NEEDS = ['team', 'plan', 'github'] as const
export type CloudSetupNeed = (typeof CLOUD_SETUP_NEEDS)[number]

export const CLOUD_SETUP_SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/

export type CloudSetupStartArgs = {
  /** https://github.com/<owner>/<repo> of the project, when the workspace needs GitHub access. */
  repo?: string
  needs: CloudSetupNeed[]
  /** Ask which team even when the profile already has an active one. */
  chooseTeam?: boolean
  /**
   * COPY-LINK-FIRST-CLICK: false starts the same setup without opening the browser; a signed-in
   * start then returns the session's link (`url`) to copy instead.
   */
  openBrowser?: boolean
}

export type CloudSetupStartResult =
  | {
      status: 'opened'
      sessionId: string
      expiresAt: number
      /** Only for `openBrowser: false`: the link the browser would have opened. */
      url?: string
    }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

export type CloudSetupStepState = 'done' | 'needed' | 'active' | 'pending' | 'failed' | 'optional'

export type CloudSetupSessionStep = {
  id: 'account' | 'team' | 'plan' | 'github'
  state: CloudSetupStepState
  /** team: its name · plan: 'trial' | 'subscription' | 'checkout' · github: 'requested'. */
  detail?: string
}

/** Error kinds the setup tracker shows (spec X1); `detail` carries e.g. the other account's email. */
export const CLOUD_SETUP_ERROR_KINDS = [
  'timed_out',
  'checkout_canceled',
  'bank_step',
  'trial_unavailable',
  'team_create_failed',
  'wrong_account'
] as const
export type CloudSetupErrorKind = (typeof CLOUD_SETUP_ERROR_KINDS)[number]

export type CloudSetupSession = {
  id: string
  steps: CloudSetupSessionStep[]
  team: { orgId: string; name: string | null; created: boolean } | null
  trial: { includedSeconds: number; usedSeconds: number; exhausted: boolean } | null
  plan: 'subscription' | 'trial' | null
  finished: boolean
  error: { kind: CloudSetupErrorKind; detail?: string } | null
  expiresAt: number
}

export type CloudSetupGetResult =
  | { status: 'ok'; session: CloudSetupSession }
  /** Expired, or it belongs to another account. */
  | { status: 'not-found' }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'failed'; error: string }

export type CloudSetupLinkResult =
  | { status: 'ok'; url: string }
  | { status: 'not-found' }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'failed'; error: string }
