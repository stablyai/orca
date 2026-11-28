/** Long enough to answer the macOS keychain's access or unlock dialog, which reading agy's login
 *  can raise. */
export const ANTIGRAVITY_KEYCHAIN_PROMPT_WAIT_MS = 60_000
/** Clients wait this long for an account action that may read agy's login. */
export const ANTIGRAVITY_ACCOUNT_ACTION_TIMEOUT_MS = ANTIGRAVITY_KEYCHAIN_PROMPT_WAIT_MS + 30_000

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
    /** agy is signed in, but Orca hasn't read which account since its login last changed: that
     *  read may ask for keychain access, so only `accounts.antigravityReadCurrent` makes it. The
     *  other fields are empty and no saved account is active. Absent from older hosts. */
    unread?: true
  } | null
  selectedAccountId: string | null
  /** New agy launches put the selected account back when another saved one took agy's login.
   *  Absent from older hosts, Windows and WSL, where a moved login stays as it is. */
  restoresSelectionAtLaunch?: true
  /** Host only: new chats run on agy and its signed-in account; false runs them elsewhere, or on a
   *  signed-out agy (`chatAgySignedOut`). Absent from older hosts and WSL. */
  chatUsesAgy?: boolean
  /** That agy's version, when new chats run on it. */
  chatAgyVersion?: string
  /** Host only: new chats run on agy, which isn't signed in yet. Absent from older hosts and WSL. */
  chatAgySignedOut?: boolean
  /** Where new Google-account chats run, as the route answered: agy, or Orca's server sign-in.
   *  Absent when the saved method isn't Google account, the route didn't answer in time, on older
   *  hosts and on WSL; Settings shows the Google sign-in choice only where it is present. */
  chatGoogleSignInInUse?: 'agy' | 'orca'
  /** Host only: new Gemini API key chats run on agy (in a home Orca owns) with the
   *  method and credential saved here. Absent from older hosts, which run them on the server. */
  chatKeyOnAgy?: boolean
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

export type AntigravityChatSignInIntent = 'signIn' | 'changeAccount'

/** Where a chat sign-in flow on the execution host stands; `url` is the Google page to open. */
export type AntigravityChatSignInState = {
  /** Null, with no `url`, for every client but the one that started the flow: only it can act. */
  flowId: string | null
  phase: (typeof ANTIGRAVITY_CHAT_SIGN_IN_PHASES)[number]
  /** The initiating action; absent on older hosts and other clients' flows. */
  intent?: AntigravityChatSignInIntent
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

/** Older hosts return only the accepted flow's id. */
export type AntigravityChatSignInStartResult = {
  flowId: string
  status?: AntigravityChatSignInStatus
}
