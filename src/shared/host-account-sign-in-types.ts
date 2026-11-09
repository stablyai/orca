import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from './managed-account-types'

export type HostAccountSignInProvider = 'claude' | 'codex'

export type HostAccountSignInPhase =
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'signedIn'
  | 'failed'
  | 'cancelled'

/** What a login running on the host asks of the person on another device. */
export type HostAccountSignInPrompt = {
  url: string
  /** Codex's one-time device code, typed into that page. */
  userCode: string | null
  /** Claude shows a code after sign-in that has to come back to the host. */
  needsCode: boolean
  /** Browser sign-in: the host login's localhost callback port, which the client forwards here. */
  callbackPort?: number
  /** Browser sign-in: Claude's paste-code page, a fallback that needs no forwarded callback. */
  pasteUrl?: string
}

/** How a login running on the host reaches the person signing in elsewhere. */
export type HostAccountSignInChannel = {
  signal: AbortSignal
  onPrompt: (prompt: HostAccountSignInPrompt) => void
  /** The code the person pasted back; rejects if the flow ends first. */
  nextCode: () => Promise<string>
  /** Run the login's browser flow and publish its localhost callback instead of a code-only flow. */
  callback?: boolean
}

/** One sign-in as the host reports it to the client that started it. */
export type HostAccountSignInStatus = {
  flowId: string
  provider: HostAccountSignInProvider
  revision: number
  phase: HostAccountSignInPhase
  prompt?: HostAccountSignInPrompt
  /** English text; older clients show it as-is. */
  error?: string
  /** Set when `error` is Orca's own HOST_ACCOUNT_SIGN_IN_FAILURE_COPY text; absent from older hosts. */
  errorCode?: string
  claude?: ClaudeRateLimitAccountsState
  codex?: CodexRateLimitAccountsState
}

// One English table for sign-in failures Orca names itself; the login's own errors stay uncoded.
export const HOST_ACCOUNT_SIGN_IN_FAILURE_COPY = {
  ownerSilent: 'The device that started this sign-in stopped answering.',
  superseded: 'An account change on this host stopped the sign-in. Start it again.'
} as const

export type HostAccountSignInFailureCode = keyof typeof HOST_ACCOUNT_SIGN_IN_FAILURE_COPY

export const HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES: ReadonlySet<HostAccountSignInPhase> = new Set([
  'signedIn',
  'failed',
  'cancelled'
])

// Why a fixed list: the host publishes this page and the client opens it, so neither trusts the other.
const SIGN_IN_PAGE_HOSTS: Record<HostAccountSignInProvider, ReadonlySet<string>> = {
  claude: new Set(['claude.com', 'claude.ai']),
  codex: new Set(['auth.openai.com'])
}

/** Whether `url` is an https page of the provider's own sign-in host. */
export function isHostAccountSignInPage(provider: HostAccountSignInProvider, url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && SIGN_IN_PAGE_HOSTS[provider].has(parsed.hostname)
  } catch {
    return false
  }
}

export const LOCAL_CALLBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/** The loopback port a sign-in page redirects back to, or null when it is not a localhost callback. */
export function signInCallbackPort(url: string): number | null {
  try {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '')
    const port = Number(redirect.port)
    return redirect.protocol === 'http:' &&
      LOCAL_CALLBACK_HOSTS.has(redirect.hostname) &&
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65_535
      ? port
      : null
  } catch {
    return null
  }
}
