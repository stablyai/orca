import type { HostAccountSignInPhase } from '../agent-accounts/host-account-sign-in-types'
import type { GoogleClientView } from './google-client-config'
import type { GoogleService, GoogleServiceChoice } from './google-scopes'

// Host serves google.*: import a Desktop client, connect and disconnect accounts, and the bot toggle.
export const GOOGLE_CONNECT_RUNTIME_CAPABILITY = 'google.connect.v1' as const
/** The host checks Gmail and Calendar automation rules itself. */
export const GOOGLE_TRIGGERS_RUNTIME_CAPABILITY = 'google.triggers.v1' as const
/** The host starts a Google setup that makes a new app beside the one it has. */
export const GOOGLE_SETUP_NEW_APP_RUNTIME_CAPABILITY = 'google.setupNewApp.v1' as const
/** Host serves google.bot.connected: a Connect card's sign-in reaches the bot as a hidden card answer. */
export const GOOGLE_CONNECTED_ANSWER_RUNTIME_CAPABILITY = 'google.connectedAnswer.v1' as const
/** Host keeps a bot's chosen Google accounts; an older host drops the list and grants every account. */
export const GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY = 'google.botAccounts.v1' as const
/** A paired window that draws Google setup's Connect card, so a server posts it instead of a line. */
export const GOOGLE_SETUP_CARDS_CLIENT_CAPABILITY = 'google.setupCards.v1' as const

/** Google never sent the person back in time; often its own Access blocked page stopped them. */
export const GOOGLE_SIGN_IN_EXPIRED = 'The Google sign-in expired. Start again in Orca.'

/** What one harmless read per API found. */
export type GoogleServiceState =
  | 'ready'
  /** The person unticked it on Google's consent page; Reconnect asks again. */
  | 'needs-permission'
  /** The API is off in the client's Google Cloud project; `enableUrl` turns it on. */
  | 'api-disabled'
  | 'blocked-by-admin'
  | 'error'

export type GoogleServiceReadiness = {
  service: GoogleService
  state: GoogleServiceState
  /** Google's own words, when the state needs them. */
  detail?: string
  enableUrl?: string
}

export type GoogleAccountView = {
  email: string
  /** `reconnect`: Google ended this sign-in (revoked, expired, or the client was deleted). */
  status: 'connected' | 'reconnect'
  reason?: string
  /** Google's own words for why it ended the sign-in. */
  googleError?: string
  services: GoogleServiceReadiness[]
  checkedAt?: number
  connectedAt: number
  /** The app it signed in through (never its secret); absent from an older host. */
  app?: { clientId: string; projectId?: string }
}

/** What a Connect asks the host for; `currentApp`: a saved account signs in through this computer's app (a setup that just made it). */
export type GoogleSignInAsk = {
  services: readonly GoogleServiceChoice[]
  account?: string
  currentApp?: boolean
}

/** Whether Google still knows this computer's app key; `gone` once its client or project was removed. */
export type GoogleClientKeyState = 'works' | 'gone' | 'unknown'

export type GoogleStatusView = {
  client: GoogleClientView | null
  /** The last check of the key, when it was this key (`check` runs a fresh one). */
  clientKey?: GoogleClientKeyState
  accounts: GoogleAccountView[]
  /**
   * The account calls and triggers without `--account` use; null with no account. Absent from a host
   * too old to keep one, where a second account would break those calls.
   */
  defaultAccount?: string | null
  /** The bots on this host whose Google toggle is on; `accounts` absent is every account. */
  bots: { id: string; name: string; accounts?: string[] }[]
}

/** The link the person opens; `redirectUri` is where Google sends the browser back to. */
export type GoogleSignInPrompt = {
  authorizeUrl: string
  redirectUri: string
  expiresAt: number
  /** The host opened it in its own browser. */
  browserOpened: boolean
}

export type GoogleSignInStatus = {
  flowId: string
  revision: number
  phase: HostAccountSignInPhase
  prompt?: GoogleSignInPrompt
  error?: string
  account?: GoogleAccountView
}
