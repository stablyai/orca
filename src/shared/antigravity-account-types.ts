export type AntigravityAccountSummary = {
  id: string
  email: string | null
  subject: string | null
  authMethod: string
  createdAt: number
  updatedAt: number
}

export type AntigravityAccountState = {
  accounts: AntigravityAccountSummary[]
  activeAccountId: string | null
  currentAccount: {
    email: string | null
    subject: string | null
    authMethod: string
    identityKnown: boolean
  } | null
  selectedAccountId: string | null
}

export const ANTIGRAVITY_CHAT_SIGN_IN_PHASES = [
  'starting',
  'waiting',
  // Google's answer is with the server, and a session on it checks that the sign-in works.
  'verifying',
  'signedIn',
  'failed',
  'cancelled',
  'expired'
] as const

/** Where a chat sign-in flow on the execution host stands; `url` is the Google page to open. */
export type AntigravityChatSignInState = {
  /** Null, with no `url`, for every client but the one that started the flow: only it can act. */
  flowId: string | null
  phase: (typeof ANTIGRAVITY_CHAT_SIGN_IN_PHASES)[number]
  url?: string
  error?: string
}

/** The server's latest answer on this host: a chat session started, or it asked to sign in.
 *  Unknown until one, after every host start. */
export type AntigravityChatAuth = 'unknown' | 'signedIn' | 'signedOut'

/** This host's chat sign-in, from a host with `accounts.antigravity-chat-sign-in.v1`. */
export type AntigravityChatSignInStatus = {
  revision: number
  auth: AntigravityChatAuth
  /** The latest flow; an ended one stays readable until the next starts. */
  flow: AntigravityChatSignInState | null
}

export type AntigravityAccountTarget = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}
